import { createReadStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import * as Piece from '@filoz/synapse-core/piece'
import type { Commit } from '@filoz/synapse-core/sp'
import { type MetadataObject, SIZE_CONSTANTS } from '@filoz/synapse-core/utils'
import { CliError, isCliError } from 'clipact'
import type { Address, Hex } from 'viem'
import {
  ErrorCodes,
  invalidInput,
  notFound,
  operationError,
} from '../errors.ts'
import { APPLICATION_SOURCE } from '../source.ts'
import { transaction } from '../state/db.ts'
import { createId } from '../state/ids.ts'
import {
  acquireOperation,
  type Checkpoint,
  createOperation,
  getOperation,
  type LegacyCommit,
  type Operation,
  releaseOperation,
  type StorageFormat,
  updateOperation,
} from '../state/operations.ts'
import { getResource, type Resource, saveResource } from '../state/resources.ts'
import { packDirectory, packFile } from './pack.ts'
import type {
  CommittedPiece,
  Placement,
  StorageBackend,
  UploadQuote,
} from './types.ts'
import { type RetrievalUrls, resourceUrls, retrievalUrls } from './urls.ts'

/** Data-set metadata namespacing CLI uploads of raw files (`put --raw`). */
export const RAW_DATA_SET_METADATA = { source: APPLICATION_SOURCE }

/**
 * Data-set metadata for CARs of files and folders. `withIPFSIndexing` asks
 * Curio to index the CAR so `/ipfs/<rootCid>` retrieval works.
 */
export const CAR_DATA_SET_METADATA = {
  source: APPLICATION_SOURCE,
  withIPFSIndexing: '',
}

/** Longest metadata value FWSS accepts. */
const MAX_METADATA_VALUE = 96

/**
 * A step of a job, reported as progress. `link` is not a step: it reports
 * the retrieval link as soon as it works, before the commit confirms.
 */
export type JobPhase =
  | 'packing'
  | 'hashing'
  | 'placing'
  | 'uploading'
  | 'link'
  | 'committing'
  | 'removing'

/** Everything a put or delete job needs besides its saved record. */
export type JobContext = {
  db: DatabaseSync
  backend: StorageBackend
  chainId: string
  payer: string
  /** filecoin-api origin for retrieval links. */
  apiUrl: string
  /** Staging directory for an operation. */
  stagingDir: (operationId: string) => string
  /** Aborted on SIGINT, SIGTERM, or SIGHUP; stops at the next step. */
  signal?: AbortSignal
  /** Progress for the caller to report on stderr. */
  progress?: (event: {
    phase: JobPhase
    message: string
    data?: Record<string, unknown>
  }) => void
  /** Called once the job's operation is saved and locked. */
  onOperation?: (operation: Operation) => void
}

/** Outcome of a put or delete, shaped for command output. */
export type JobResult = {
  operationId: string
  state: 'ready' | 'removal_pending'
  resource: Resource
  urls: RetrievalUrls
}

/** Options for {@link startPut}. */
export type StartPutOptions = {
  path: string
  name?: string | undefined
  providerId?: bigint | undefined
  /** Store a file's exact bytes instead of a UnixFS CAR. */
  raw?: boolean | undefined
}

/** A file or directory checked for a put. */
type PutSource = {
  sourcePath: string
  kind: 'file' | 'folder'
  format: StorageFormat
  name: string
  /** Bytes of a raw file; CARs are sized after packing. */
  size?: number
}

/** Check that `path` is a storable file or directory. */
async function inspectSource(options: StartPutOptions): Promise<PutSource> {
  const sourcePath = resolve(options.path)
  const stats = await stat(sourcePath).catch(() => undefined)
  if (!stats || !(stats.isFile() || stats.isDirectory())) {
    throw invalidInput(`No file or directory at ${options.path}.`, 'path')
  }
  const name = options.name ?? basename(sourcePath)
  if (stats.isDirectory()) {
    if (options.raw) {
      throw invalidInput('--raw stores only files, not directories.', 'raw')
    }
    return { sourcePath, kind: 'folder', format: 'car', name }
  }
  if (!options.raw) return { sourcePath, kind: 'file', format: 'car', name }
  assertPieceSize(stats.size)
  return { sourcePath, kind: 'file', format: 'raw', name, size: stats.size }
}

/**
 * Storage format of a saved put. Operations saved before `format` existed
 * stored folders as CARs and files raw.
 */
function formatOf(input: Operation['input']): StorageFormat {
  return input.format ?? (input.kind === 'folder' ? 'car' : 'raw')
}

/**
 * Validate the input, save a new put operation before any external mutation,
 * then run it.
 */
export async function startPut(
  ctx: JobContext,
  options: StartPutOptions
): Promise<JobResult> {
  const source = await inspectSource(options)
  const op = createOperation(ctx.db, {
    action: 'put',
    resourceRef: createId('res'),
    chainId: ctx.chainId,
    payer: ctx.payer,
    input: {
      sourcePath: source.sourcePath,
      name: source.name,
      kind: source.kind,
      format: source.format,
      providerId: options.providerId?.toString(),
    },
  })
  return await runOperation(ctx, op.id)
}

/** What a put would do, from {@link estimatePut}. */
export type PutEstimate = {
  kind: 'file' | 'folder'
  name: string
  /** Bytes to store: the raw file, or the packed CAR. */
  size: number
  /** Files in a directory; 1 for a file. */
  files: number
  /** IPFS root CID of a CAR; absent for a raw file. */
  rootCid?: string
  /** Chosen provider and quote, when a session key is available. */
  placement?: Placement
  quote?: UploadQuote
}

/** Options for {@link estimatePut}. */
export type EstimatePutOptions = StartPutOptions & {
  /** Prices the upload; omitted when not logged in. */
  backend?: StorageBackend | undefined
}

/**
 * Describe a put without side effects on providers or the chain: content
 * inventory, stored size, and, with a backend, the provider it would use and
 * what it would cost. CARs are packed only to measure them; nothing is
 * written to disk.
 */
export async function estimatePut(
  options: EstimatePutOptions
): Promise<PutEstimate> {
  const source = await inspectSource(options)
  let estimate: PutEstimate
  if (source.format === 'raw') {
    estimate = {
      kind: source.kind,
      name: source.name,
      size: source.size ?? 0,
      files: 1,
    }
  } else {
    const pack = source.kind === 'folder' ? packDirectory : packFile
    const packed = await pack(source.sourcePath)
    assertPieceSize(packed.size)
    estimate = {
      kind: source.kind,
      name: source.name,
      size: packed.size,
      files: packed.files,
      rootCid: packed.rootCid.toString(),
    }
  }
  if (!options.backend) return estimate
  const placement = await options.backend.selectPlacement({
    metadata: metadataFor(source.format),
    providerId: options.providerId,
  })
  const quote = await options.backend.quote({ size: estimate.size, placement })
  return { ...estimate, placement, quote }
}

/**
 * Run or resume an operation. A completed operation returns its saved
 * outcome. Otherwise this takes the execution lock, continues from the saved
 * checkpoint, and records failures so the job can be resumed with
 * `filecoin operations resume`.
 */
export async function runOperation(
  ctx: JobContext,
  operationId: string
): Promise<JobResult> {
  const saved = getOperation(ctx.db, operationId)
  if (!saved) throw notFound(`Operation ${operationId} not found.`)
  if (saved.executionStatus === 'completed') return savedOutcome(ctx, saved)
  const op = acquireOperation(ctx.db, operationId)
  try {
    ctx.onOperation?.(op)
    return op.action === 'put'
      ? await runPut(ctx, op)
      : await runRemove(ctx, op)
  } catch (error) {
    updateOperation(ctx.db, op.id, {
      executionStatus: 'failed',
      pid: null,
      error: ctx.signal?.aborted
        ? 'Interrupted'
        : error instanceof Error
          ? error.message
          : String(error),
    })
    // clipact reports an interruption itself, with the checkpoint's steps.
    if (ctx.signal?.aborted) throw error
    throw operationError(error, op.id)
  } finally {
    releaseOperation(op.id)
  }
}

/** The saved outcome of a completed operation; nothing is re-run. */
export function savedOutcome(
  ctx: Pick<JobContext, 'db' | 'apiUrl'>,
  op: Operation
): JobResult {
  const resource = getResource(ctx.db, op.resourceRef)
  if (!resource) {
    throw notFound(`Resource ${op.resourceRef} of ${op.id} no longer exists.`)
  }
  return jobResult(ctx, op, resource)
}

/** Shape a finished operation and its resource for command output. */
function jobResult(
  ctx: Pick<JobContext, 'apiUrl'>,
  op: Operation,
  resource: Resource
): JobResult {
  return {
    operationId: op.id,
    state: op.action === 'put' ? 'ready' : 'removal_pending',
    resource,
    urls: resourceUrls(resource, ctx.apiUrl),
  }
}

/**
 * Save the resource and mark the operation completed in one transaction, so
 * a stop at this point leaves a finished job, never a half-finished one.
 */
function complete(
  ctx: JobContext,
  op: Operation,
  resource: Resource,
  checkpoint: Checkpoint = {}
): void {
  transaction(ctx.db, () => {
    saveResource(ctx.db, resource)
    updateOperation(ctx.db, op.id, {
      executionStatus: 'completed',
      phase: 'done',
      pid: null,
      error: null,
      checkpoint,
    })
  })
}

/** Reject sizes outside the PDP piece limits. */
function assertPieceSize(size: number): void {
  if (
    size < SIZE_CONSTANTS.MIN_UPLOAD_SIZE ||
    size > SIZE_CONSTANTS.MAX_UPLOAD_SIZE
  ) {
    throw invalidInput(
      `Content must be between ${SIZE_CONSTANTS.MIN_UPLOAD_SIZE} and ${SIZE_CONSTANTS.MAX_UPLOAD_SIZE} bytes; got ${size}.`,
      'path'
    )
  }
}

/** Data-set metadata for a storage format. */
function metadataFor(format: StorageFormat) {
  return format === 'car' ? CAR_DATA_SET_METADATA : RAW_DATA_SET_METADATA
}

/**
 * Compute the PieceCID of a file by streaming it. Aborting `signal` destroys
 * the read stream, which stops the hashing.
 */
async function pieceCidOf(path: string, signal?: AbortSignal): Promise<string> {
  const stream = createReadStream(path, { signal })
  return (await Piece.calculate(stream)).toString()
}

/** Save checkpoint fields and return the updated operation. */
function save(
  ctx: JobContext,
  op: Operation,
  checkpoint: Checkpoint,
  phase?: Operation['phase']
): Operation {
  return updateOperation(ctx.db, op.id, {
    checkpoint,
    ...(phase ? { phase } : {}),
  })
}

/**
 * Put steps: pack (CARs), identify, place, upload, commit, record. Each
 * step saves its result first, so a resumed job skips completed work and
 * never sends a second commit for the same content.
 */
async function runPut(ctx: JobContext, op: Operation): Promise<JobResult> {
  const { input } = op
  const kind = input.kind ?? 'file'
  const format = formatOf(input)
  const name = input.name ?? 'upload'
  const signal = ctx.signal
  if (!input.sourcePath) throw new Error(`Operation ${op.id} has no source.`)

  // Prepare the bytes to store.
  let uploadPath = input.sourcePath
  if (format === 'car') {
    uploadPath = join(ctx.stagingDir(op.id), `${kind}.car`)
    const staged = await stat(uploadPath).catch(() => undefined)
    if (!staged) {
      if (op.checkpoint.pieceCid) {
        throw new CliError({
          code: ErrorCodes.stagingMissing,
          message: `The staged CAR of ${op.id} is missing, so it cannot be resumed.`,
          next: [
            {
              by: 'agent',
              command: `filecoin put ${input.sourcePath}`,
              description: `Start a new put of the same ${kind}`,
            },
          ],
        })
      }
      op = save(ctx, op, {}, 'packing')
      ctx.progress?.({
        phase: 'packing',
        message: `Packing ${input.sourcePath}`,
      })
      const pack = kind === 'folder' ? packDirectory : packFile
      const packed = await pack(input.sourcePath, uploadPath)
      op = save(ctx, op, {
        rootCid: packed.rootCid.toString(),
        size: packed.size,
      })
    }
  }

  signal?.throwIfAborted()
  const size = (await stat(uploadPath)).size
  assertPieceSize(size)
  ctx.progress?.({ phase: 'hashing', message: 'Computing PieceCID' })
  const pieceCid = await pieceCidOf(uploadPath, signal)
  if (op.checkpoint.pieceCid && op.checkpoint.pieceCid !== pieceCid) {
    throw new CliError({
      code: ErrorCodes.sourceChanged,
      message: `${uploadPath} changed since operation ${op.id} started.`,
      next: [
        {
          by: 'agent',
          command: `filecoin put ${input.sourcePath}`,
          description: 'Start a new put with the current content',
        },
      ],
    })
  }
  op = save(ctx, op, { pieceCid, size }, 'storing')

  // Choose a provider once; resumes reuse it.
  let placement = placementOf(op.checkpoint)
  if (!placement) {
    ctx.progress?.({
      phase: 'placing',
      message: 'Selecting a storage provider',
    })
    placement = await ctx.backend.selectPlacement({
      metadata: metadataFor(format),
      providerId: input.providerId ? BigInt(input.providerId) : undefined,
    })
    const quote = await ctx.backend.quote({ size, placement })
    if (!quote.ready) throw insufficientFunds(quote)
    op = save(ctx, op, {
      providerId: placement.providerId.toString(),
      serviceURL: placement.serviceURL,
      payee: placement.payee,
      ...(placement.dataSetId == null
        ? {}
        : {
            dataSetId: placement.dataSetId.toString(),
            clientDataSetId: placement.clientDataSetId?.toString(),
          }),
    })
  }

  // Upload unless the provider already has the piece.
  if (!(op.checkpoint.commit || op.checkpoint.stored)) {
    const present = await ctx.backend.hasPiece({
      serviceURL: placement.serviceURL,
      pieceCid,
    })
    if (!present) {
      ctx.progress?.({
        phase: 'uploading',
        message: `Uploading ${size} bytes to provider ${placement.providerId}`,
      })
      await ctx.backend.upload({
        serviceURL: placement.serviceURL,
        path: uploadPath,
        size,
        pieceCid,
      })
    }
    op = save(ctx, op, { stored: true })
  }

  // Links that work before the commit confirms. The provider hint makes
  // filecoin-api redirect to the provider, which serves a parked piece at once.
  // A CAR's browser link needs Curio's IPFS index, which Curio starts
  // building when it receives the commit, so it is reported after sending.
  const early = retrievalUrls({
    apiUrl: ctx.apiUrl,
    chainId: op.chainId,
    pieceCid,
    rootCid: op.checkpoint.rootCid,
    providerId: placement.providerId.toString(),
  })
  const reportLink = () =>
    ctx.progress?.({
      phase: 'link',
      message: early.browser,
      data: { pieceCid, urls: early },
    })
  if (format === 'raw') reportLink()

  const committed = await commit(
    ctx,
    op,
    placement,
    { pieceCid, name },
    format === 'car' ? reportLink : undefined
  )

  // Once committed, the indexer ranks the copies; the links need no hint.
  const urls = retrievalUrls({
    apiUrl: ctx.apiUrl,
    chainId: op.chainId,
    pieceCid,
    rootCid: op.checkpoint.rootCid,
  })

  const resource: Resource = {
    ref: op.resourceRef,
    kind,
    name,
    chainId: op.chainId,
    payer: op.payer,
    pieceCid,
    ...(op.checkpoint.rootCid ? { rootCid: op.checkpoint.rootCid } : {}),
    size,
    copies: [
      {
        providerId: placement.providerId.toString(),
        dataSetId: committed.dataSetId.toString(),
        pieceId: committed.pieceId.toString(),
        serviceURL: placement.serviceURL,
      },
    ],
    url: urls.browser,
    status: 'active',
    createdAt: new Date().toISOString(),
  }
  complete(ctx, op, resource, {
    dataSetId: committed.dataSetId.toString(),
    pieceId: committed.pieceId.toString(),
  })
  if (format === 'car') {
    await rm(ctx.stagingDir(op.id), { recursive: true, force: true }).catch(
      () => undefined
    )
  }
  return { operationId: op.id, state: 'ready', resource, urls }
}

/**
 * Commit the stored piece on chain exactly once. The commit is signed with a
 * fresh nonce and saved before it is sent. A resume first asks FWSS whether
 * that nonce was used; if so, the commit landed and nothing is sent. If not,
 * the same signature is sent again, and FWSS rejects any second use of its
 * nonce, so at most one commit takes effect.
 *
 * @see https://github.com/filecoin-project/agents/issues/1
 */
async function commit(
  ctx: JobContext,
  op: Operation,
  placement: Placement,
  piece: { pieceCid: string; name: string },
  onSent?: () => void
): Promise<CommittedPiece> {
  const metadata = metadataFor(formatOf(op.input))
  const pieceMetadata: Record<string, string> = {
    name: piece.name.slice(0, MAX_METADATA_VALUE),
    ...(op.checkpoint.rootCid ? { ipfsRootCID: op.checkpoint.rootCid } : {}),
  }
  let signed: Commit | undefined
  if (op.checkpoint.commit) {
    signed = toCommit(op.checkpoint.commit, {
      placement,
      payer: op.payer as Address,
      pieceCid: piece.pieceCid,
      metadata,
      pieceMetadata,
    })
    const landed = await ctx.backend.findCommit({ commit: signed })
    if (landed) return landed
  }

  op = save(ctx, op, signed ? { commit: signed } : {}, 'committing')
  if (!signed) {
    ctx.progress?.({ phase: 'committing', message: 'Signing the commit' })
    signed = await ctx.backend.signCommit({
      placement,
      pieceCid: piece.pieceCid,
      metadata,
      pieceMetadata,
    })
    op = save(ctx, op, { commit: signed })
  }

  if (!op.checkpoint.transactionHash) {
    ctx.progress?.({
      phase: 'committing',
      message:
        signed.kind === 'createDataSetAndAddPieces'
          ? 'Creating data set and adding piece'
          : 'Adding piece',
    })
    const submission = await ctx.backend.submitCommit({
      serviceURL: placement.serviceURL,
      commit: signed,
    })
    op = save(ctx, op, { transactionHash: submission.transactionHash })
  }

  onSent?.()
  // clipact repeats this line with the elapsed time while the wait lasts, so
  // the user can look the transaction up meanwhile.
  const transactionHash = op.checkpoint.transactionHash as Hex
  ctx.progress?.({
    phase: 'committing',
    message: `Waiting for confirmation of transaction ${transactionHash}`,
    data: { transactionHash },
  })
  try {
    return await ctx.backend.waitForCommit({ commit: signed, transactionHash })
  } catch (error) {
    if (isCliError(error) && error.code === ErrorCodes.commitRejected) {
      // The transaction did not use the nonce; forget it so a resume sends
      // the same signature again.
      save(ctx, op, { statusUrl: undefined, transactionHash: undefined })
    }
    throw error
  }
}

/**
 * The synapse-core {@link Commit} of a saved commit. A {@link LegacyCommit}
 * saved by `filecoin` 0.7.0 and earlier holds only the signature and its
 * IDs; the rest comes from the placement and the piece it was signed for.
 * `submitCommit` sends only the pieces' CIDs and the signed `extraData`.
 */
function toCommit(
  saved: Commit | LegacyCommit,
  signedFor: {
    placement: Placement
    payer: Address
    pieceCid: string
    metadata: MetadataObject
    pieceMetadata: MetadataObject
  }
): Commit {
  if ('kind' in saved) return saved
  const { placement, payer } = signedFor
  const pieces = [
    { pieceCid: signedFor.pieceCid, metadata: signedFor.pieceMetadata },
  ]
  if (saved.created) {
    if (saved.clientDataSetId == null) {
      throw new Error('A saved create commit has no client data set ID.')
    }
    return {
      kind: 'createDataSetAndAddPieces',
      clientDataSetId: saved.clientDataSetId,
      nonce: saved.nonce,
      payee: placement.payee,
      payer,
      metadata: signedFor.metadata,
      cdn: false,
      pieces,
      extraData: saved.extraData,
    }
  }
  if (placement.dataSetId == null || placement.clientDataSetId == null) {
    throw new Error('A saved add commit has no data set IDs.')
  }
  return {
    kind: 'addPieces',
    dataSetId: placement.dataSetId.toString(),
    clientDataSetId: placement.clientDataSetId.toString(),
    nonce: saved.nonce,
    payer,
    pieces,
    extraData: saved.extraData,
  }
}

/** Error returned when the payer cannot cover an upload. */
function insufficientFunds(quote: UploadQuote): CliError {
  return new CliError({
    code: ErrorCodes.insufficientFunds,
    message:
      quote.depositNeeded === 0n
        ? 'The payer must approve Warm Storage before uploading.'
        : quote.needsApproval
          ? 'The payer must deposit USDFC and approve Warm Storage before uploading.'
          : 'The payer must deposit more USDFC before uploading.',
    details: {
      fundingUrl: quote.fundingUrl,
      depositNeeded: quote.depositNeeded.toString(),
      needsApproval: quote.needsApproval,
    },
    next: [
      {
        by: 'user',
        description:
          quote.depositNeeded === 0n
            ? `Approve Warm Storage at ${quote.fundingUrl}`
            : `Fund the account at ${quote.fundingUrl}`,
      },
    ],
  })
}

/** Rebuild a saved placement from a checkpoint. */
function placementOf(checkpoint: Checkpoint): Placement | undefined {
  if (!(checkpoint.providerId && checkpoint.serviceURL && checkpoint.payee)) {
    return undefined
  }
  return {
    providerId: BigInt(checkpoint.providerId),
    serviceURL: checkpoint.serviceURL,
    payee: checkpoint.payee as `0x${string}`,
    ...(checkpoint.dataSetId && checkpoint.clientDataSetId
      ? {
          dataSetId: BigInt(checkpoint.dataSetId),
          clientDataSetId: BigInt(checkpoint.clientDataSetId),
        }
      : {}),
  }
}

/**
 * Save a new delete operation for a managed resource, then run it.
 */
export async function startRemove(
  ctx: JobContext,
  ref: string
): Promise<JobResult> {
  const resource = getResource(ctx.db, ref, ctx)
  if (!resource) {
    throw notFound(`No managed resource ${ref} for this account.`, {
      by: 'agent',
      command: 'filecoin ls',
      description: 'List managed resources',
    })
  }
  if (resource.status !== 'active') {
    throw invalidInput(`${ref} is already pending removal.`, 'ref')
  }
  const [copy] = resource.copies
  if (!copy) throw new Error(`Resource ${ref} has no stored copies.`)
  const op = createOperation(ctx.db, {
    action: 'delete',
    resourceRef: ref,
    chainId: ctx.chainId,
    payer: ctx.payer,
    input: {},
    checkpoint: {
      providerId: copy.providerId,
      serviceURL: copy.serviceURL,
      dataSetId: copy.dataSetId,
      pieceId: copy.pieceId,
    },
  })
  return await runOperation(ctx, op.id)
}

/**
 * Schedule removal of the resource's piece and wait for the transaction.
 * The provider deletes the data at its next proving boundary, so the result
 * is `removal_pending`. A reverted transaction leaves the resource active.
 */
async function runRemove(ctx: JobContext, op: Operation): Promise<JobResult> {
  const resource = getResource(ctx.db, op.resourceRef)
  if (!resource) throw notFound(`Resource ${op.resourceRef} no longer exists.`)
  const { serviceURL, dataSetId, pieceId } = op.checkpoint
  if (!(serviceURL && dataSetId && pieceId)) {
    throw new Error(`Operation ${op.id} is missing its removal target.`)
  }
  if (!op.checkpoint.transactionHash) {
    op = save(ctx, op, {}, 'removing')
    ctx.progress?.({
      phase: 'removing',
      message: `Scheduling removal of piece ${pieceId}`,
    })
    const { transactionHash } = await ctx.backend.schedulePieceRemoval({
      serviceURL,
      dataSetId: BigInt(dataSetId),
      pieceId: BigInt(pieceId),
    })
    op = save(ctx, op, { transactionHash })
  }
  const hash = op.checkpoint.transactionHash as `0x${string}`
  ctx.progress?.({
    phase: 'removing',
    message: `Waiting for confirmation of removal transaction ${hash}`,
    data: { transactionHash: hash },
  })
  const { scheduled } = await ctx.backend.waitForRemoval({
    transactionHash: hash,
    dataSetId: BigInt(dataSetId),
    pieceId: BigInt(pieceId),
  })
  if (!scheduled) {
    // The transaction had no effect; a resume signs a new one.
    save(ctx, op, { transactionHash: undefined })
    throw new CliError({
      code: ErrorCodes.removalReverted,
      message: `Removal transaction ${hash} did not schedule the piece for removal; it is still stored.`,
    })
  }
  const updated: Resource = { ...resource, status: 'removal_pending' }
  complete(ctx, op, updated)
  return jobResult(ctx, op, updated)
}

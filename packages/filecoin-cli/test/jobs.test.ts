import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import * as Piece from '@filoz/synapse-core/piece'
import type { Commit } from '@filoz/synapse-core/sp'
import { SIZE_CONSTANTS } from '@filoz/synapse-core/utils'
import { CliError } from 'clipact'
import type { Hex } from 'viem'
import { invalidInput, operationError } from '../src/errors.ts'
import { openDatabase } from '../src/state/db.ts'
import {
  createOperation,
  getOperation,
  type LegacyCommit,
  listOperations,
  type Operation,
  updateOperation,
} from '../src/state/operations.ts'
import { type Copy, getResource } from '../src/state/resources.ts'
import {
  CAR_DATA_SET_METADATA,
  estimatePut,
  type JobContext,
  type PutResult,
  RAW_DATA_SET_METADATA,
  runOperation,
  savedOutcome,
  startPut,
  startRemove,
} from '../src/storage/jobs.ts'
import type { CommittedPiece, StorageBackend } from '../src/storage/types.ts'
import { tempDir } from './helpers.ts'

const TX = `0x${'aa'.repeat(32)}` as Hex
const PAYER: Hex = '0x00000000000000000000000000000000000000aa'

/** Options for {@link fakeBackend}. */
type FakeOptions = {
  existingDataSet?: boolean
  stored?: boolean
  /** The payer cannot afford the upload. */
  unfunded?: boolean
  /** The payer has funds but has not approved Warm Storage. */
  unapproved?: boolean
  /** The first commit wait fails, as if the connection dropped. */
  failWaitOnce?: boolean
  /** The first submission lands on chain but its response is lost. */
  loseResponseOnce?: boolean
  /** The first submission fails before reaching the provider. */
  failSubmitOnce?: boolean
  /** The first commit transaction is reported as failed. */
  rejectOnce?: boolean
  /** The first removal transaction reverts. */
  revertOnce?: boolean
  /** The first streamed upload fails after reading its body. */
  failUploadOnce?: boolean
  /** Providers that can hold the second copy, in the order they answer. */
  secondaryProviders?: bigint[]
  /** This many pulls fail before one succeeds. */
  failPulls?: number
  /** The commit wait with this 1-based index fails, as if it dropped. */
  failWaitAt?: number
  /** On-chain state of pieces by `dataSetId/pieceId`; default `live`. */
  pieces?: Record<string, 'live' | 'scheduled' | 'removed'>
  /** Payer of every data set on chain; default the context's payer. */
  dataSetPayer?: Hex
  /** First-copy providers chosen by each selection, in order; default 7. */
  primaryIds?: bigint[]
  /** The first quote reports the payer short of funds. */
  unfundedOnce?: boolean
}

/**
 * A storage backend that records calls and simulates FWSS: a submitted
 * commit lands under its nonce unless it is rejected, and `findCommit` reads
 * that record the way `clientNonces` does.
 */
function fakeBackend(options: FakeOptions = {}) {
  const calls = {
    select: [] as unknown[],
    upload: 0,
    /** PieceCIDs of the streamed uploads, in order. */
    streamed: [] as string[],
    sign: 0,
    submitted: [] as Hex[],
    commits: [] as Commit[],
    find: 0,
    wait: 0,
    remove: 0,
    /** Placements of each quote, by provider ID. */
    quotes: [] as bigint[][],
    /** Provider IDs each secondary selection excluded. */
    excluded: [] as bigint[][],
    pulls: [] as { serviceURL: string; sourceUrl: string; extraData: Hex }[],
    /** Removals scheduled, as `dataSetId/pieceId`. */
    removals: [] as string[],
    /** Pieces read on chain before a removal, as `dataSetId/pieceId`. */
    states: [] as string[],
  }
  const pieces = new Map(Object.entries(options.pieces ?? {}))
  const landed = new Map<string, CommittedPiece>()
  const once = { ...options }
  const backend: StorageBackend = {
    selectPlacement(opts) {
      calls.select.push(opts.metadata)
      const id = options.primaryIds?.[calls.select.length - 1] ?? 7n
      return Promise.resolve({
        providerId: id,
        serviceURL:
          id === 7n ? 'https://sp.example' : `https://sp${id}.example`,
        payee: `0x${id.toString(16).padStart(40, '0')}` as Hex,
        ...(options.existingDataSet
          ? { dataSetId: 42n, clientDataSetId: 9n }
          : {}),
      })
    },
    selectSecondaryPlacement({ excludeProviderIds }) {
      calls.excluded.push(excludeProviderIds)
      const id = (options.secondaryProviders ?? []).find(
        (candidate) => !excludeProviderIds.includes(candidate)
      )
      return Promise.resolve(
        id == null
          ? undefined
          : {
              providerId: id,
              serviceURL: `https://sp${id}.example`,
              payee: `0x${id.toString(16).padStart(40, '0')}` as Hex,
            }
      )
    },
    pullPiece({ serviceURL, commit, sourceUrl }) {
      calls.pulls.push({ serviceURL, sourceUrl, extraData: commit.extraData })
      if ((once.failPulls ?? 0) > 0) {
        once.failPulls = (once.failPulls ?? 0) - 1
        return Promise.reject(new Error('pull failed'))
      }
      return Promise.resolve()
    },
    quote: ({ placements }) => {
      calls.quotes.push(placements.map((placement) => placement.providerId))
      const short = once.unfundedOnce ?? false
      once.unfundedOnce = false
      return Promise.resolve({
        ready: !(options.unfunded || options.unapproved || short),
        depositNeeded: options.unfunded ? 10n ** 18n : 0n,
        needsApproval: options.unapproved ?? false,
        ratePerMonth: 123n,
        lockup: 456n,
        fundingUrl:
          'https://pay.example/console/setup?network=calibration&approval=unlimited',
      })
    },
    hasPiece: () => Promise.resolve(options.stored ?? false),
    upload() {
      calls.upload++
      return Promise.resolve()
    },
    async uploadStream({ data, size }) {
      calls.upload++
      let length = 0
      const hasher = Piece.hasher()
      for await (const chunk of data) {
        hasher.write(chunk)
        length += chunk.length
      }
      assert.equal(length, size)
      const pieceCid = hasher.finalize().toString()
      calls.streamed.push(pieceCid)
      if (once.failUploadOnce) {
        once.failUploadOnce = false
        throw new Error('connection reset')
      }
      return { pieceCid }
    },
    signCommit({ placement, pieceCid, metadata, pieceMetadata }) {
      calls.sign++
      const signed = {
        nonce: String(calls.sign),
        payer: PAYER,
        pieces: [{ pieceCid, metadata: pieceMetadata }],
        extraData: `0x0${calls.sign}` as Hex,
      }
      const commit: Commit =
        placement.dataSetId == null
          ? {
              ...signed,
              kind: 'createDataSetAndAddPieces',
              clientDataSetId: '77',
              payee: placement.payee,
              metadata,
              cdn: false,
            }
          : {
              ...signed,
              kind: 'addPieces',
              dataSetId: placement.dataSetId.toString(),
              clientDataSetId: String(placement.clientDataSetId),
            }
      return Promise.resolve(commit)
    },
    submitCommit({ commit }) {
      calls.submitted.push(commit.extraData)
      calls.commits.push(commit)
      if (once.failSubmitOnce) {
        once.failSubmitOnce = false
        return Promise.reject(new Error('connect ECONNREFUSED'))
      }
      landed.set(commit.nonce, {
        dataSetId: commit.kind === 'addPieces' ? 42n : 100n,
        pieceId: 5n,
      })
      if (once.loseResponseOnce) {
        once.loseResponseOnce = false
        return Promise.reject(new Error('socket hang up'))
      }
      return Promise.resolve({ transactionHash: TX })
    },
    findCommit({ commit }) {
      calls.find++
      return Promise.resolve(landed.get(commit.nonce))
    },
    waitForCommit({ commit }) {
      calls.wait++
      const { nonce } = commit
      if (calls.wait === options.failWaitAt) {
        return Promise.reject(new Error('connection reset'))
      }
      if (once.failWaitOnce) {
        once.failWaitOnce = false
        return Promise.reject(new Error('connection reset'))
      }
      if (once.rejectOnce) {
        once.rejectOnce = false
        landed.delete(nonce)
        return Promise.reject(
          new CliError({ code: 'commit_rejected', message: 'failed' })
        )
      }
      const piece = landed.get(nonce)
      if (!piece)
        return Promise.reject(new Error(`nothing landed for ${nonce}`))
      return Promise.resolve(piece)
    },
    pieceState({ dataSetId, pieceId }) {
      const key = `${dataSetId}/${pieceId}`
      calls.states.push(key)
      return Promise.resolve({
        payer: options.dataSetPayer ?? PAYER,
        state: pieces.get(key) ?? 'live',
      })
    },
    schedulePieceRemoval({ dataSetId, pieceId }) {
      calls.remove++
      calls.removals.push(`${dataSetId}/${pieceId}`)
      return Promise.resolve({ transactionHash: TX })
    },
    waitForRemoval({ dataSetId, pieceId }) {
      if (once.revertOnce) {
        once.revertOnce = false
        return Promise.resolve({ scheduled: false })
      }
      pieces.set(`${dataSetId}/${pieceId}`, 'scheduled')
      return Promise.resolve({ scheduled: true })
    },
  }
  return { backend, calls }
}

/** Build a job context over a fresh database. */
async function context(
  backend: StorageBackend
): Promise<JobContext & { root: string; started: string[] }> {
  const root = await tempDir()
  const started: string[] = []
  return {
    root,
    started,
    db: openDatabase(join(root, 'state')),
    backend,
    chainId: '314159',
    payer: PAYER,
    apiUrl: 'https://api.example',
    stagingDir: (id) => join(root, 'state', 'staging', id),
    onOperation: (op) => started.push(op.id),
  }
}

/** Write a random file of `size` bytes under the context root. */
async function file(ctx: { root: string }, name: string, size: number) {
  const path = join(ctx.root, name)
  await writeFile(path, randomBytes(size))
  return path
}

/** Resume an operation that must be a put, and return its outcome. */
async function resumePut(ctx: JobContext, id: string): Promise<PutResult> {
  const result = await runOperation(ctx, id)
  assert.equal(result.state, 'ready')
  return result as PutResult
}

/** Delete a managed resource's copies, as `filecoin delete <ref>` does. */
function removeResource(ctx: JobContext, ref: string) {
  const resource = getResource(ctx.db, ref)
  return startRemove(ctx, {
    target: ref,
    copies: (resource?.copies ?? []).map((copy) => ({
      ...copy,
      resourceRef: ref,
    })),
  })
}

/** The only operation of a context's account. */
function onlyOperation(ctx: JobContext) {
  const { items } = listOperations(ctx.db, {
    chainId: ctx.chainId,
    payer: ctx.payer,
    limit: 2,
  })
  assert.equal(items.length, 1)
  return items[0] as NonNullable<(typeof items)[0]>
}

test('put --raw stores a file in a new data set and records the resource', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path, raw: true })
  assert.equal(result.state, 'ready')
  assert.equal(result.resource.kind, 'file')
  assert.equal(result.resource.name, 'report.pdf')
  assert.equal(result.resource.rootCid, undefined)
  assert.equal(result.resource.size, 4096)
  assert.deepEqual(result.resource.copies, [
    {
      providerId: '7',
      dataSetId: '100',
      pieceId: '5',
      serviceURL: 'https://sp.example',
    },
  ])
  assert.deepEqual(result.urls, {
    piece: `https://api.example/get/${result.resource.pieceCid}?network=calibration`,
    browser: `https://api.example/get/${result.resource.pieceCid}?network=calibration&browser=true`,
  })
  assert.equal(result.resource.url, result.urls.browser)
  assert.deepEqual(calls.select, [RAW_DATA_SET_METADATA])
  // On-chain namespace: changing it orphans existing data sets.
  assert.deepEqual(RAW_DATA_SET_METADATA, { source: 'filecoin-cli' })
  assert.deepEqual(CAR_DATA_SET_METADATA, {
    source: 'filecoin-cli',
    withIPFSIndexing: '',
  })
  assert.equal(calls.submitted.length, 1)
  assert.deepEqual(ctx.started, [result.operationId])
  const op = getOperation(ctx.db, result.operationId)
  assert.equal(op?.executionStatus, 'completed')
  assert.equal(op?.phase, 'done')
  assert.equal(op?.pid, undefined)
})

/** Progress events of a put, recorded in order. */
function recordProgress(ctx: JobContext) {
  const events: {
    phase: string
    message: string
    data?: Record<string, unknown>
  }[] = []
  ctx.progress = (event) => events.push(event)
  return events
}

test('put --raw reports a file link with the provider hint once it is parked', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path, raw: true })
  const phases = events.map((event) => event.phase)
  assert.ok(phases.indexOf('link') > phases.indexOf('uploading'))
  assert.ok(phases.indexOf('link') < phases.indexOf('committing'))
  const link = events.find((event) => event.phase === 'link')
  assert.deepEqual(link?.data, {
    pieceCid: result.resource.pieceCid,
    urls: {
      piece: `${result.urls.piece}&provider=7`,
      browser: `${result.urls.browser}&provider=7`,
    },
  })
  assert.equal(link?.message, `${result.urls.browser}&provider=7`)
})

test('put stores a file as a CAR with its IPFS root CID by default', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path })
  assert.equal(result.resource.kind, 'file')
  const { rootCid } = result.resource
  assert.ok(rootCid?.startsWith('bafkrei'))
  assert.ok(result.resource.size > 4096)
  assert.deepEqual(result.urls, {
    piece: `https://api.example/get/${result.resource.pieceCid}?network=calibration`,
    browser: `https://api.example/get/${rootCid}?network=calibration&browser=true`,
  })
  assert.deepEqual(calls.select, [CAR_DATA_SET_METADATA])
  assert.deepEqual(calls.commits[0]?.pieces[0]?.metadata, {
    name: 'report.pdf',
    ipfsRootCID: rootCid,
  })
  const op = getOperation(ctx.db, result.operationId)
  assert.equal(op?.input.format, 'car')
  // The browser link needs the IPFS index, so it follows the commit.
  const phases = events.map((event) => event.phase)
  assert.ok(phases.indexOf('link') > phases.indexOf('committing'))
  await assert.rejects(stat(ctx.stagingDir(result.operationId)), {
    code: 'ENOENT',
  })
})

test('put --raw rejects a directory', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await assert.rejects(startPut(ctx, { path: dir, raw: true }), {
    code: 'invalid_input',
  })
  assert.equal(
    listOperations(ctx.db, { chainId: ctx.chainId, payer: ctx.payer, limit: 1 })
      .items.length,
    0
  )
})

test('a file put saved without a format by filecoin 0.7.0 resumes raw', async () => {
  const { backend, calls } = fakeBackend({ failSubmitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path, raw: true }))
  const failed = onlyOperation(ctx)
  const { format: _, ...legacyInput } = failed.input
  ctx.db
    .prepare('update operations set input = ? where id = ?')
    .run(JSON.stringify(legacyInput), failed.id)

  // As a CAR, the resume would fail: no CAR was staged for this put.
  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.rootCid, undefined)
  assert.equal(result.resource.size, 2048)
  assert.equal(calls.upload, 1)
})

test('put reports a folder link once the commit is sent', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')

  const result = await startPut(ctx, { path: dir })
  const messages = events.map((event) => event.message)
  const link = events.findIndex((event) => event.phase === 'link')
  const waiting = messages.findIndex((m) =>
    m.startsWith('Waiting for confirmation of transaction 0x')
  )
  assert.ok(link > messages.indexOf('Creating data set and adding piece'))
  assert.ok(link < waiting)
  assert.equal(
    messages[waiting],
    `Waiting for confirmation of transaction ${events[waiting]?.data?.transactionHash}`
  )
  assert.deepEqual(events[link]?.data, {
    pieceCid: result.resource.pieceCid,
    urls: {
      piece: `${result.urls.piece}&provider=7`,
      browser: result.urls.browser,
    },
  })
})

test('put packs a directory, adds to an existing data set, and cleans staging', async () => {
  const { backend, calls } = fakeBackend({ existingDataSet: true })
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')

  const result = await startPut(ctx, { path: dir })
  assert.equal(result.resource.kind, 'folder')
  assert.ok(result.resource.rootCid)
  assert.deepEqual(result.urls, {
    piece: `https://api.example/get/${result.resource.pieceCid}?network=calibration`,
    browser: `https://api.example/get/${result.resource.rootCid}?network=calibration&browser=true`,
  })
  assert.equal(result.resource.url, result.urls.browser)
  assert.deepEqual(calls.select, [CAR_DATA_SET_METADATA])
  assert.equal(result.resource.copies[0]?.dataSetId, '42')
  await assert.rejects(stat(ctx.stagingDir(result.operationId)), {
    code: 'ENOENT',
  })
})

test('put errors carry the operation ID and a resume step, never retryable', async () => {
  const { backend } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)

  const error = await startPut(ctx, { path }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'operation_failed')
  assert.equal(error.retryable, false)
  const op = onlyOperation(ctx)
  assert.equal(
    (error.details as { operationId?: string } | undefined)?.operationId,
    op.id
  )
  assert.deepEqual(error.next?.at(-1), {
    by: 'agent',
    command: `filecoin operations resume ${op.id}`,
    description: 'Continue this operation with its saved input',
  })
  assert.equal(op.executionStatus, 'failed')
})

test('operation errors add the ID to details only for filecoin CLI codes', () => {
  const resume = 'filecoin operations resume op_1'
  const invalid = operationError(invalidInput('Too small.', 'path'), 'op_1')
  assert.deepEqual(invalid.details, [{ path: 'path', message: 'Too small.' }])
  assert.equal(invalid.next?.at(-1)?.command, resume)

  const down = operationError(
    new CliError({ code: 'service_unavailable', message: 'Down.' }),
    'op_1'
  )
  assert.equal(down.details, undefined)
  assert.equal(down.retryable, false)
  assert.equal(down.next?.at(-1)?.command, resume)

  const details = { fundingUrl: 'u', depositNeeded: '1', needsApproval: false }
  const funds = operationError(
    new CliError({ code: 'insufficient_funds', message: 'Fund.', details }),
    'op_1'
  )
  assert.deepEqual(funds.details, { ...details, operationId: 'op_1' })
})

test('resume after a dropped wait finds the landed commit without sending', async () => {
  const { backend, calls } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.state, 'ready')
  assert.equal(calls.upload, 1)
  assert.equal(calls.sign, 1)
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.select.length, 1)
})

test('resume after a lost commit response does not commit twice (#1)', async () => {
  const { backend, calls } = fakeBackend({ loseResponseOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }), { code: 'operation_failed' })
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.transactionHash, undefined)
  assert.ok(failed.checkpoint.commit)

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.copies[0]?.dataSetId, '100')
  assert.equal(calls.sign, 1)
  assert.equal(calls.submitted.length, 1)
})

test('resume resends the same signature when the commit never landed (#1)', async () => {
  const { backend, calls } = fakeBackend({ failSubmitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)

  await runOperation(ctx, failed.id)
  assert.equal(calls.sign, 1)
  assert.equal(calls.submitted.length, 2)
  assert.equal(calls.submitted[0], calls.submitted[1])
})

test('a rejected commit is resent with the same signature on resume', async () => {
  const { backend, calls } = fakeBackend({ rejectOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }), { code: 'commit_rejected' })
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.transactionHash, undefined)

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.state, 'ready')
  assert.equal(calls.sign, 1)
  assert.deepEqual(calls.submitted, ['0x01', '0x01'])
})

/**
 * Rewrite an operation's saved commit in the shape `filecoin` 0.7.0 saved,
 * with the provider status URL it saved after sending.
 */
function saveLegacyCommit(
  ctx: JobContext,
  id: string,
  options: { statusUrl?: string } = {}
): LegacyCommit {
  const op = getOperation(ctx.db, id)
  const commit = op?.checkpoint.commit
  assert.ok(commit && 'kind' in commit)
  const legacy: LegacyCommit = {
    created: commit.kind === 'createDataSetAndAddPieces',
    nonce: commit.nonce,
    ...(commit.kind === 'createDataSetAndAddPieces'
      ? { clientDataSetId: commit.clientDataSetId }
      : {}),
    extraData: commit.extraData,
  }
  updateOperation(ctx.db, id, {
    checkpoint: { commit: legacy, ...options },
  })
  return legacy
}

test('resume sends a commit saved by filecoin 0.7.0 as a synapse-core commit', async () => {
  const { backend, calls } = fakeBackend({ failSubmitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path, raw: true }))
  const failed = onlyOperation(ctx)
  const legacy = saveLegacyCommit(ctx, failed.id)

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.state, 'ready')
  assert.equal(calls.sign, 1)
  assert.deepEqual(calls.commits[1], {
    kind: 'createDataSetAndAddPieces',
    clientDataSetId: legacy.clientDataSetId,
    nonce: legacy.nonce,
    payee: '0x0000000000000000000000000000000000000007',
    payer: PAYER,
    metadata: RAW_DATA_SET_METADATA,
    cdn: false,
    pieces: [
      { pieceCid: result.resource.pieceCid, metadata: { name: 'data.bin' } },
    ],
    extraData: legacy.extraData,
  })
  assert.deepEqual(calls.commits[1], calls.commits[0])
})

test('resume finds a landed commit saved by filecoin 0.7.0 with its status URL', async () => {
  const { backend, calls } = fakeBackend({
    existingDataSet: true,
    failWaitOnce: true,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)
  saveLegacyCommit(ctx, failed.id, { statusUrl: 'https://sp.example/status/1' })

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.copies[0]?.dataSetId, '42')
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.find, 1)
})

test('resume of a completed operation returns its saved outcome (#4)', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })

  const again = await runOperation(ctx, put.operationId)
  assert.deepEqual(again, put)
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.upload, 1)
})

test('put stops with insufficient_funds, a funding step, and the operation', async () => {
  const { backend, calls } = fakeBackend({ unfunded: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const error = await startPut(ctx, { path }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'insufficient_funds')
  assert.deepEqual(
    error.next?.map((step) => step.by),
    ['user', 'agent']
  )
  assert.equal(
    (error.details as { operationId?: string } | undefined)?.operationId,
    onlyOperation(ctx).id
  )
  assert.equal(calls.upload, 0)
})

test('put asks only for the approval when no deposit is needed', async () => {
  const { backend } = fakeBackend({ unapproved: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const error = await startPut(ctx, { path }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'insufficient_funds')
  assert.equal(
    error.message,
    'The payer must approve Warm Storage before uploading.'
  )
  assert.match(
    String(error.next?.[0]?.description),
    /^Approve Warm Storage at /
  )
})

test('put --raw skips the upload when the provider already has the piece', async () => {
  const { backend, calls } = fakeBackend({ stored: true })
  const ctx = await context(backend)
  const phases: string[] = []
  ctx.progress = (event) => phases.push(event.phase)
  const path = await file(ctx, 'data.bin', 1024)
  await startPut(ctx, { path, raw: true })
  assert.equal(calls.upload, 0)
  assert.equal(calls.submitted.length, 1)
  assert.ok(phases.includes('link'))
})

test('put streams a CAR even when the provider has the piece', async () => {
  const { backend, calls } = fakeBackend({ stored: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const result = await startPut(ctx, { path })
  assert.equal(calls.upload, 1)
  assert.deepEqual(calls.streamed, [result.resource.pieceCid])
})

test('a CAR put resumed after a failed upload streams the same piece', async () => {
  const { backend, calls } = fakeBackend({ failUploadOnce: true })
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'a.bin'), randomBytes(2_500_000))
  await writeFile(join(dir, 'b.txt'), 'hello world'.repeat(20))
  await assert.rejects(startPut(ctx, { path: dir }))
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.stored, undefined)
  assert.equal(failed.checkpoint.pieceCid, undefined)
  assert.ok(failed.checkpoint.rootCid)

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.rootCid, failed.checkpoint.rootCid)
  assert.equal(calls.streamed.length, 2)
  assert.equal(calls.streamed[0], calls.streamed[1])
  assert.equal(result.resource.pieceCid, calls.streamed[1])
  assert.equal(result.resource.size, failed.checkpoint.size)
})

test('a CAR put resumed after its source changed fails with source_changed', async () => {
  const { backend, calls } = fakeBackend({ failUploadOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 4096)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)
  await writeFile(path, randomBytes(4096))
  await assert.rejects(runOperation(ctx, failed.id), {
    code: 'source_changed',
  })
  assert.equal(calls.streamed.length, 1)
})

test('a source changed during the upload fails with source_changed', async () => {
  const { backend } = fakeBackend()
  let path = ''
  const ctx = await context({
    ...backend,
    async uploadStream({ data }) {
      await writeFile(path, randomBytes(2_100_000))
      // fetch reports a failed body as its own error.
      try {
        for await (const _ of data);
      } catch {
        throw new TypeError('fetch failed')
      }
      throw new Error('the changed source was uploaded')
    },
  })
  path = await file(ctx, 'data.bin', 2_100_000)
  await assert.rejects(startPut(ctx, { path }), { code: 'source_changed' })
})

test('a stored CAR put resumes without its source', async () => {
  const { backend, calls } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 4096)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.stored, true)
  await rm(path)
  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.pieceCid, failed.checkpoint.pieceCid)
  assert.equal(calls.upload, 1)
})

test('a CAR put staged by an older version restreams as a DFS CAR', async () => {
  const { backend, calls } = fakeBackend({ failUploadOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 4096)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)
  // Older versions saved the staged CAR's PieceCID before uploading it.
  updateOperation(ctx.db, failed.id, {
    checkpoint: { pieceCid: 'bafkzcibstaged' },
  })
  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.pieceCid, calls.streamed[1])
})

test('resume refuses a source that changed since the job started', async () => {
  const { backend } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  await assert.rejects(startPut(ctx, { path, raw: true }))
  const failed = onlyOperation(ctx)
  await writeFile(path, randomBytes(1024))
  await assert.rejects(runOperation(ctx, failed.id), {
    code: 'source_changed',
  })
})

test('put rejects content below the minimum piece size', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const path = join(ctx.root, 'tiny.txt')
  await writeFile(path, 'hi')
  await assert.rejects(startPut(ctx, { path }), { code: 'invalid_input' })
})

test('put rejects content over the piece limit before packing', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  // A sparse file: its size is past the limit, but it takes no disk space.
  const path = join(ctx.root, 'huge.bin')
  await writeFile(path, '')
  await truncate(path, SIZE_CONSTANTS.MAX_UPLOAD_SIZE + 1)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'huge.bin'), '')
  await truncate(join(dir, 'huge.bin'), SIZE_CONSTANTS.MAX_UPLOAD_SIZE + 1)

  for (const target of [path, dir]) {
    await assert.rejects(startPut(ctx, { path: target }), {
      code: 'invalid_input',
    })
    await assert.rejects(estimatePut({ path: target }), {
      code: 'invalid_input',
    })
  }
  const { items } = listOperations(ctx.db, {
    chainId: ctx.chainId,
    payer: ctx.payer,
    limit: 1,
  })
  assert.equal(items.length, 0)
  await assert.rejects(stat(join(ctx.root, 'state', 'staging')), {
    code: 'ENOENT',
  })
  assert.equal(calls.select.length, 0)
})

test('an interrupted put fails with the abort reason, not operation_failed', async () => {
  const { backend } = fakeBackend()
  const controller = new AbortController()
  const ctx = await context({
    ...backend,
    uploadStream() {
      controller.abort('SIGTERM')
      return Promise.reject(new Error('aborted'))
    },
  })
  ctx.signal = controller.signal
  const path = await file(ctx, 'data.bin', 1024)
  await assert.rejects(startPut(ctx, { path }), { message: 'aborted' })
  const op = onlyOperation(ctx)
  assert.equal(op.executionStatus, 'failed')
  assert.equal(op.error, 'Interrupted')
})

test('delete schedules removal and marks the resource pending', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })
  const events = recordProgress(ctx)

  const removed = await removeResource(ctx, put.resource.ref)
  assert.equal(removed.state, 'removal_pending')
  assert.equal(calls.remove, 1)
  assert.deepEqual(events.at(-1), {
    phase: 'removing',
    message: `Waiting for confirmation of removal transaction ${TX}`,
    data: { transactionHash: TX },
  })
  assert.equal(getResource(ctx.db, put.resource.ref)?.status, 'removal_pending')
  assert.equal(
    getOperation(ctx.db, removed.operationId)?.executionStatus,
    'completed'
  )
  await assert.rejects(removeResource(ctx, put.resource.ref), {
    code: 'invalid_input',
  })
})

test('a reverted removal keeps the resource and is resumable (#2)', async () => {
  const { backend, calls } = fakeBackend({ revertOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })

  const error = await removeResource(ctx, put.resource.ref).catch(
    (e: unknown) => e
  )
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'removal_reverted')
  assert.equal(getResource(ctx.db, put.resource.ref)?.status, 'active')
  const operationId = (error.details as { operationId?: string } | undefined)
    ?.operationId as string
  const failed = getOperation(ctx.db, operationId)
  assert.equal(failed?.executionStatus, 'failed')
  assert.equal(failed?.checkpoint.transactionHash, undefined)

  const resumed = await runOperation(ctx, operationId)
  assert.equal(resumed.state, 'removal_pending')
  assert.equal(calls.remove, 2)
})

test('estimatePut sizes a directory and prices it without side effects', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)'.repeat(20))

  const estimate = await estimatePut({ path: dir, backend })
  assert.equal(estimate.kind, 'folder')
  assert.equal(estimate.files, 2)
  assert.ok(estimate.rootCid)
  assert.ok(estimate.size > 0)
  assert.equal(estimate.quote?.ratePerMonth, 123n)
  assert.equal(estimate.placement?.providerId, 7n)
  assert.equal(calls.upload + calls.sign + calls.submitted.length, 0)

  const offline = await estimatePut({ path: dir })
  assert.equal(offline.quote, undefined)
  assert.equal(offline.rootCid, estimate.rootCid)
})

test('estimatePut packs a file by default and sizes it raw with --raw', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'report.pdf', 4096)

  const car = await estimatePut({ path, backend })
  assert.equal(car.kind, 'file')
  assert.ok(car.rootCid)
  assert.ok(car.size > 4096)
  const raw = await estimatePut({ path, backend, raw: true })
  assert.equal(raw.rootCid, undefined)
  assert.equal(raw.size, 4096)
  assert.deepEqual(calls.select, [CAR_DATA_SET_METADATA, RAW_DATA_SET_METADATA])
})

test('put stores a second copy that the next provider pulls from the first', async () => {
  const { backend, calls } = fakeBackend({ secondaryProviders: [8n] })
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path, raw: true })
  assert.equal(result.requestedCopies, 2)
  assert.equal(result.copyFailures, undefined)
  assert.deepEqual(result.resource.copies, [
    {
      providerId: '7',
      dataSetId: '100',
      pieceId: '5',
      serviceURL: 'https://sp.example',
    },
    {
      providerId: '8',
      dataSetId: '100',
      pieceId: '5',
      serviceURL: 'https://sp8.example',
    },
  ])
  // Both copies are priced together before anything is uploaded.
  assert.deepEqual(calls.quotes, [[7n, 8n]])
  assert.equal(calls.upload, 1)
  // The pull carries the second commit's signature and reads the first copy.
  assert.deepEqual(calls.pulls, [
    {
      serviceURL: 'https://sp8.example',
      sourceUrl: `https://sp.example/piece/${result.resource.pieceCid}`,
      extraData: calls.submitted[1],
    },
  ])
  assert.equal(calls.submitted.length, 2)
  const phases = events.map((event) => event.phase)
  assert.ok(phases.lastIndexOf('committing') < phases.indexOf('copying'))
  assert.equal(getResource(ctx.db, result.resource.ref)?.copies.length, 2)
  assert.deepEqual(
    savedOutcome(ctx, getOperation(ctx.db, result.operationId) as Operation),
    result
  )
})

test('a failed pull moves the second copy to another provider', async () => {
  const { backend, calls } = fakeBackend({
    secondaryProviders: [8n, 9n],
    failPulls: 1,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)

  const result = await startPut(ctx, { path })
  assert.deepEqual(
    result.resource.copies.map((copy) => copy.providerId),
    ['7', '9']
  )
  assert.deepEqual(result.copyFailures, [
    { providerId: '8', error: 'pull failed' },
  ])
  assert.deepEqual(calls.excluded.at(-1), [7n, 8n])
  // The abandoned commit for provider 8 was signed but never sent.
  assert.equal(calls.sign, 3)
  assert.equal(calls.submitted.length, 2)
})

test('put keeps one copy when no second provider can store it', async () => {
  const { backend, calls } = fakeBackend({
    secondaryProviders: [8n],
    failPulls: 10,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)

  const result = await startPut(ctx, { path })
  assert.equal(result.state, 'ready')
  assert.equal(result.resource.copies.length, 1)
  assert.equal(result.requestedCopies, 2)
  assert.deepEqual(result.copyFailures, [
    { providerId: '8', error: 'pull failed' },
    { error: 'No other approved provider is reachable.' },
  ])
  assert.equal(calls.submitted.length, 1)

  const { backend: alone } = fakeBackend()
  const single = await startPut(await context(alone), { path })
  assert.equal(single.resource.copies.length, 1)
  assert.deepEqual(single.copyFailures, [
    { error: 'No other approved provider is reachable.' },
  ])
})

test('resume after a dropped second-copy wait finds its commit without sending', async () => {
  const { backend, calls } = fakeBackend({
    secondaryProviders: [8n],
    failWaitAt: 2,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }), { code: 'operation_failed' })
  const failed = onlyOperation(ctx)
  assert.equal(failed.phase, 'copying')
  assert.ok(failed.checkpoint.secondary?.transactionHash)
  assert.equal(getResource(ctx.db, failed.resourceRef as string), undefined)

  const result = await resumePut(ctx, failed.id)
  assert.equal(result.resource.copies.length, 2)
  assert.equal(calls.upload, 1)
  assert.equal(calls.pulls.length, 1)
  assert.equal(calls.submitted.length, 2)
})

test('delete schedules removal of every copy', async () => {
  const { backend, calls } = fakeBackend({
    secondaryProviders: [8n],
    existingDataSet: true,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })
  assert.equal(put.resource.copies.length, 2)

  const removed = await removeResource(ctx, put.resource.ref)
  assert.equal(removed.state, 'removal_pending')
  assert.deepEqual(calls.removals, ['42/5', '100/5'])
  assert.deepEqual(
    removed.removals.map((removal) => removal.state),
    ['scheduled', 'scheduled']
  )
  assert.equal(removed.resources[0]?.status, 'removal_pending')
})

test('a resumed delete skips the copies already scheduled', async () => {
  // Copies in data sets 42 and 100, so each has its own on-chain state.
  const { backend, calls } = fakeBackend({
    secondaryProviders: [8n],
    existingDataSet: true,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })
  let waits = 0
  const wait = backend.waitForRemoval
  backend.waitForRemoval = (options) =>
    ++waits === 2 ? Promise.resolve({ scheduled: false }) : wait(options)

  const error = await removeResource(ctx, put.resource.ref).catch(
    (e: unknown) => e
  )
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'removal_reverted')
  assert.equal(getResource(ctx.db, put.resource.ref)?.status, 'active')
  const failed = onlyFailed(ctx)
  assert.deepEqual(
    failed.checkpoint.removals?.map((removal) => removal.scheduled ?? false),
    [true, false]
  )

  const resumed = await runOperation(ctx, failed.id)
  assert.equal(resumed.state, 'removal_pending')
  assert.equal(calls.remove, 3)
})

test('a delete saved by filecoin 0.7.0 resumes its one flat target', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })
  const op = createOperation(ctx.db, {
    action: 'delete',
    resourceRef: put.resource.ref,
    chainId: ctx.chainId,
    payer: ctx.payer,
    input: {},
    checkpoint: {
      providerId: '7',
      serviceURL: 'https://sp.example',
      dataSetId: '100',
      pieceId: '5',
      transactionHash: TX,
    },
  })

  const resumed = await runOperation(ctx, op.id)
  assert.equal(resumed.state, 'removal_pending')
  // The saved transaction is waited on, not sent again.
  assert.equal(calls.remove, 0)
  assert.equal(getResource(ctx.db, put.resource.ref)?.status, 'removal_pending')
})

test('estimatePut prices both copies and names the second provider', async () => {
  const { backend, calls } = fakeBackend({ secondaryProviders: [8n] })
  const ctx = await context(backend)
  const path = await file(ctx, 'report.pdf', 4096)

  const estimate = await estimatePut({ path, backend })
  assert.equal(estimate.secondaryPlacement?.providerId, 8n)
  assert.deepEqual(calls.quotes, [[7n, 8n]])
  assert.equal(calls.pulls.length + calls.sign, 0)
})

/** The only failed operation of a context's account. */
function onlyFailed(ctx: JobContext) {
  const { items } = listOperations(ctx.db, {
    chainId: ctx.chainId,
    payer: ctx.payer,
    limit: 10,
    incomplete: true,
  })
  assert.equal(items.length, 1)
  return items[0] as NonNullable<(typeof items)[0]>
}

test('a resume never puts both copies on the provider it picks first', async () => {
  // The funds check stops the first run after the second placement is
  // saved; the resume then picks that provider for the first copy.
  const { backend, calls } = fakeBackend({
    primaryIds: [7n, 8n],
    secondaryProviders: [8n, 7n],
    unfundedOnce: true,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }), { code: 'insufficient_funds' })
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.secondary?.placement?.providerId, '8')

  const result = await resumePut(ctx, failed.id)
  assert.deepEqual(
    result.resource.copies.map((copy) => copy.providerId),
    ['8', '7']
  )
  assert.deepEqual(calls.quotes, [
    [7n, 8n],
    [8n, 7n],
  ])
})

test('a put saved by filecoin 0.7.0 resumes with one copy', async () => {
  const { backend, calls } = fakeBackend({ secondaryProviders: [8n] })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  const op = createOperation(ctx.db, {
    action: 'put',
    resourceRef: 'res_legacy',
    chainId: ctx.chainId,
    payer: ctx.payer,
    input: { sourcePath: path, name: 'data.bin', kind: 'file', format: 'raw' },
  })

  const result = await resumePut(ctx, op.id)
  assert.equal(result.resource.copies.length, 1)
  assert.equal(result.requestedCopies, 1)
  assert.equal(result.copyFailures, undefined)
  assert.deepEqual(calls.quotes, [[7n]])
  assert.equal(calls.pulls.length + calls.excluded.length, 0)
  assert.equal(getOperation(ctx.db, op.id)?.checkpoint.secondary, undefined)
})

/** A copy no managed resource holds, as filecoin-api reports it. */
function indexedCopy(dataSetId: string, pieceId: string) {
  return {
    providerId: '9',
    serviceURL: 'https://sp9.example',
    dataSetId,
    pieceId,
    source: 'filecoin-pin',
  }
}

test('delete removes copies no managed resource holds', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)

  const removed = await startRemove(ctx, {
    target: 'bafkzcibpiece',
    copies: [indexedCopy('500', '1'), indexedCopy('501', '3')],
  })
  assert.deepEqual(calls.states, ['500/1', '501/3'])
  assert.deepEqual(calls.removals, ['500/1', '501/3'])
  assert.deepEqual(removed, {
    operationId: removed.operationId,
    state: 'removal_pending',
    target: 'bafkzcibpiece',
    removals: [
      {
        dataSetId: '500',
        pieceId: '1',
        providerId: '9',
        source: 'filecoin-pin',
        state: 'scheduled',
        transactionHash: TX,
      },
      {
        dataSetId: '501',
        pieceId: '3',
        providerId: '9',
        source: 'filecoin-pin',
        state: 'scheduled',
        transactionHash: TX,
      },
    ],
    resources: [],
  })
  const op = getOperation(ctx.db, removed.operationId) as Operation
  assert.equal(op.resourceRef, undefined)
  assert.deepEqual(op.input, { target: 'bafkzcibpiece' })
  assert.deepEqual(savedOutcome(ctx, op), removed)
})

test('delete skips copies the chain shows scheduled or removed', async () => {
  const { backend, calls } = fakeBackend({
    pieces: { '500/1': 'scheduled', '502/0': 'removed' },
  })
  const ctx = await context(backend)

  const removed = await startRemove(ctx, {
    target: 'bafkzcibpiece',
    copies: [
      indexedCopy('500', '1'),
      indexedCopy('501', '3'),
      indexedCopy('502', '0'),
    ],
  })
  assert.deepEqual(calls.removals, ['501/3'])
  assert.deepEqual(
    removed.removals.map((removal) => removal.state),
    ['already_scheduled', 'scheduled', 'removed']
  )
})

test('delete with every copy gone saves no operation', async () => {
  const { backend, calls } = fakeBackend({ pieces: { '500/1': 'removed' } })
  const ctx = await context(backend)

  await assert.rejects(
    startRemove(ctx, { target: '500/1', copies: [indexedCopy('500', '1')] }),
    { code: 'invalid_input' }
  )
  assert.equal(calls.remove, 0)
  assert.equal(
    listOperations(ctx.db, { chainId: ctx.chainId, payer: ctx.payer, limit: 1 })
      .items.length,
    0
  )
})

test('delete refuses a data set another wallet pays for', async () => {
  const { backend, calls } = fakeBackend({
    dataSetPayer: '0x00000000000000000000000000000000000000bb',
  })
  const ctx = await context(backend)

  await assert.rejects(
    startRemove(ctx, { target: '500/1', copies: [indexedCopy('500', '1')] }),
    { code: 'invalid_input', message: /is paid for by 0x0+bb/ }
  )
  assert.equal(calls.remove, 0)
})

test('a delete of some copies keeps the resource active with the rest', async () => {
  const { backend } = fakeBackend({
    secondaryProviders: [8n],
    existingDataSet: true,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })
  const [first, second] = put.resource.copies

  const removed = await startRemove(ctx, {
    target: '42/5',
    copies: [{ ...(first as Copy), resourceRef: put.resource.ref }],
  })
  assert.deepEqual(removed.resources, [{ ...put.resource, copies: [second] }])
  const op = getOperation(ctx.db, removed.operationId) as Operation
  assert.equal(op.resourceRef, put.resource.ref)

  const rest = await removeResource(ctx, put.resource.ref)
  assert.deepEqual(rest.resources, [
    { ...put.resource, copies: [second], status: 'removal_pending' },
  ])
})

test('a resumed delete checks the chain before it signs again', async () => {
  const { backend, calls } = fakeBackend({ revertOnce: true })
  const ctx = await context(backend)
  const error = await startRemove(ctx, {
    target: '500/1',
    copies: [indexedCopy('500', '1')],
  }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'removal_reverted')
  const failed = onlyOperation(ctx)

  // Another machine removed the piece before the resume.
  const state = backend.pieceState
  backend.pieceState = () => Promise.resolve({ payer: PAYER, state: 'removed' })
  const resumed = await runOperation(ctx, failed.id)
  backend.pieceState = state
  assert.equal(resumed.state, 'removal_pending')
  assert.equal(calls.remove, 1)
  assert.deepEqual(
    resumed.state === 'removal_pending' &&
      resumed.removals.map((removal) => removal.state),
    ['removed']
  )
})

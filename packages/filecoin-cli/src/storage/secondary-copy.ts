/**
 * The second copy of a put. synapse-sdk stores two copies on two providers
 * by default, so `put` does too: after the first copy confirms, a second
 * provider pulls the piece from the first one and commits it in its own
 * data set. The user's machine uploads the bytes once.
 *
 * Client-side copies are temporary: providers may soon replicate on their
 * own. Everything specific to the second copy lives in this file. To go back
 * to one copy, delete this file, the `secondary` checkpoint field in
 * `state/operations.ts`, `SecondaryCopyBackend` in `storage/types.ts`, and
 * each call site marked `secondary-copy` in `storage/jobs.ts`,
 * `storage/synapse.ts`, and `handlers/put.ts`.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-sdk/src/storage/manager.ts
 */
import * as Piece from '@filoz/synapse-core/piece'
import type { Commit } from '@filoz/synapse-core/sp'
import * as SP from '@filoz/synapse-core/sp'
import type { MetadataObject } from '@filoz/synapse-core/utils'
import * as WarmStorage from '@filoz/synapse-core/warm-storage'
import { isCliError } from 'clipact'
import type { Address, Hex } from 'viem'
import type { App } from '../app.ts'
import type { SessionKey } from '../auth/session.ts'
import { ErrorCodes } from '../errors.ts'
import { type Operation, updateOperation } from '../state/operations.ts'
import type { Copy } from '../state/resources.ts'
import type { JobContext } from './jobs.ts'
import type { Placement, StorageBackend } from './types.ts'

/** Copies a put asks for: one, plus the second copy of this file. */
export const REQUESTED_COPIES = 2

/**
 * Providers tried for the second copy before the put settles for one. Each
 * try can wait for a whole pull, so this is lower than synapse-sdk's 5.
 */
const MAX_ATTEMPTS = 3

/** A provider that failed to store the second copy, and why. */
export type CopyFailure = { providerId?: string; error: string }

/** A {@link Placement} saved as JSON: IDs are decimal strings. */
type SavedPlacement = {
  providerId: string
  serviceURL: string
  payee: string
  dataSetId?: string
  clientDataSetId?: string
}

/**
 * Progress of the second copy, saved as `checkpoint.secondary`. Each field
 * is written before the step that depends on it, as for the first copy.
 */
export type SecondaryCheckpoint = {
  /** Providers that failed, in order. A new try excludes them. */
  failures: CopyFailure[]
  /** No provider is left to try; the put keeps one copy. */
  exhausted?: boolean
  placement?: SavedPlacement
  /** Signed commit. The pull sends its `extraData` too. */
  commit?: Commit
  /** Set once the provider has pulled and parked the piece. */
  pulled?: boolean
  /** Set once the provider accepted the commit. */
  transactionHash?: string
  /** The confirmed second copy. */
  copy?: Copy
}

/** Storage operations only the second copy needs. */
export interface SecondaryCopyBackend {
  /**
   * Choose a reachable approved provider other than `excludeProviderIds`,
   * preferring an existing data set with `metadata`. Endorsement is not
   * required. Returns `undefined` when none is left.
   */
  selectSecondaryPlacement(options: {
    metadata: MetadataObject
    excludeProviderIds: bigint[]
  }): Promise<Placement | undefined>
  /**
   * Ask the provider at `serviceURL` to fetch the commit's piece from
   * `sourceUrl`, and wait until it has parked it. The request carries the
   * commit's signed `extraData`, so the provider can check the payer's
   * authorization. Nothing is sent on chain.
   */
  pullPiece(options: {
    serviceURL: string
    commit: Commit
    sourceUrl: string
  }): Promise<void>
}

/**
 * The synapse-core {@link SecondaryCopyBackend}, mixed into the storage
 * backend by `createSynapseBackend`.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/sp/pull-pieces.ts
 */
export function createSecondaryCopyBackend(
  app: App,
  sessionKey: SessionKey
): SecondaryCopyBackend {
  const signal = app.signal
  return {
    async selectSecondaryPlacement({ metadata, excludeProviderIds }) {
      const [location] = await WarmStorage.selectReachableProviders(
        app.client,
        {
          address: sessionKey.rootAddress,
          metadata,
          count: 1,
          excludeProviderIds,
          signal,
        }
      )
      if (!location) return undefined
      const { provider, dataSetId, clientDataSetId } = location
      return {
        providerId: provider.id,
        serviceURL: provider.pdp.serviceURL,
        payee: provider.payee,
        ...(dataSetId == null || clientDataSetId == null
          ? {}
          : { dataSetId, clientDataSetId }),
      }
    },

    async pullPiece({ serviceURL, commit, sourceUrl }) {
      const pieces = commit.pieces.map((piece) => ({
        pieceCid: Piece.from(piece.pieceCid),
        sourceUrl,
      }))
      const result = await SP.waitForPullPieces(sessionKey.client, {
        serviceURL,
        pieces,
        // The signature of the commit; nothing is signed again.
        extraData: commit.extraData,
        signal,
        ...(commit.kind === 'addPieces'
          ? {
              dataSetId: BigInt(commit.dataSetId),
              clientDataSetId: BigInt(commit.clientDataSetId),
            }
          : { payee: commit.payee }),
      })
      if (result.status !== 'complete') {
        throw new Error(`Provider pull ended with status ${result.status}.`)
      }
    },
  }
}

/**
 * Choose the second copy's provider for a dry run, so its cost joins the
 * quote. Returns `undefined` when no other provider answers.
 */
export async function selectSecondary(
  backend: StorageBackend,
  options: { metadata: MetadataObject; primary: Placement }
): Promise<Placement | undefined> {
  return await backend.selectSecondaryPlacement({
    metadata: options.metadata,
    excludeProviderIds: [options.primary.providerId],
  })
}

/**
 * Choose and save the second copy's provider before anything is uploaded,
 * so the funds check covers both copies. A failure here is not fatal: the
 * put goes on and {@link storeSecondaryCopy} tries again after the first
 * copy confirms.
 */
export async function planSecondaryCopy(
  ctx: JobContext,
  op: Operation,
  options: { metadata: MetadataObject; primary: Placement }
): Promise<{ op: Operation; placement?: Placement }> {
  if (!wantsSecondary(op)) return { op }
  let saved = apart(
    op.checkpoint.secondary ?? { failures: [] },
    options.primary
  )
  if (!saved.placement && !saved.exhausted) {
    try {
      const placement = await selectSecondary(ctx.backend, options)
      saved = placement
        ? { ...saved, placement: toSaved(placement) }
        : noProviderLeft(saved)
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      saved = withFailure(saved, error)
    }
    op = persist(ctx, op, saved)
  }
  const placement = saved.placement && fromSaved(saved.placement)
  return placement ? { op, placement } : { op }
}

/** What {@link storeSecondaryCopy} reports. */
export type SecondaryCopyResult = {
  op: Operation
  /** The confirmed second copy; absent when every try failed. */
  copy?: Copy
  failures: CopyFailure[]
}

/**
 * Store the second copy once the first has confirmed. The second provider
 * pulls the piece from the first copy's `/piece` URL with a commit signed
 * for its own data set, then the commit is sent and confirmed.
 *
 * Failures before the commit is sent try another provider, up to
 * {@link MAX_ATTEMPTS}, and then let the put finish with one copy. Once the
 * commit is sent, an error fails the operation so `operations resume`
 * finds out whether the commit landed, the same way as for the first copy:
 * a commit that may have landed is never abandoned. A rejected commit used
 * no nonce, so it counts as a failed try.
 */
export async function storeSecondaryCopy(
  ctx: JobContext,
  op: Operation,
  piece: {
    primary: Placement
    pieceCid: string
    metadata: MetadataObject
    pieceMetadata: MetadataObject
  }
): Promise<SecondaryCopyResult> {
  if (!wantsSecondary(op)) return { op, failures: [] }
  const { backend } = ctx
  let saved = apart(op.checkpoint.secondary ?? { failures: [] }, piece.primary)
  const save = (next: SecondaryCheckpoint) => {
    saved = next
    op = persist(ctx, op, saved)
  }
  if (!(saved.copy || saved.exhausted)) op = persist(ctx, op, saved, 'copying')
  const sourceUrl = Piece.createPieceUrlPDP({
    cid: piece.pieceCid,
    serviceURL: piece.primary.serviceURL,
  })

  // A resume first asks FWSS whether the saved commit landed.
  if (saved.commit && saved.placement && !saved.copy) {
    const landed = await backend.findCommit({ commit: saved.commit })
    if (landed) save({ ...saved, copy: toCopy(saved.placement, landed) })
  }

  while (!(saved.copy || saved.exhausted)) {
    const { commit, placement } = saved
    if (commit && placement && saved.transactionHash) {
      const transactionHash = saved.transactionHash as Hex
      ctx.progress?.({
        phase: 'copying',
        message: `Waiting for confirmation of second copy transaction ${transactionHash}`,
        data: { transactionHash },
      })
      try {
        const landed = await backend.waitForCommit({ commit, transactionHash })
        save({ ...saved, copy: toCopy(placement, landed) })
      } catch (error) {
        if (!(isCliError(error) && error.code === ErrorCodes.commitRejected)) {
          throw error
        }
        save(withFailure(saved, error))
      }
      continue
    }

    // Nothing is on chain yet, so a failure here can move to another
    // provider without leaving a paid copy behind.
    try {
      if (!saved.placement) {
        ctx.progress?.({
          phase: 'copying',
          message: 'Selecting a provider for the second copy',
        })
        const next = await backend.selectSecondaryPlacement({
          metadata: piece.metadata,
          excludeProviderIds: excluded(saved, piece.primary),
        })
        save(
          next ? { ...saved, placement: toSaved(next) } : noProviderLeft(saved)
        )
        if (!next) break
      }
      const target = fromSaved(saved.placement as SavedPlacement)
      if (!saved.commit) {
        const signed = await backend.signCommit({
          placement: target,
          pieceCid: piece.pieceCid,
          metadata: piece.metadata,
          pieceMetadata: piece.pieceMetadata,
        })
        save({ ...saved, commit: signed })
      }
      if (!saved.pulled) {
        ctx.progress?.({
          phase: 'copying',
          message: `Provider ${target.providerId} is pulling the piece from provider ${piece.primary.providerId}`,
        })
        await backend.pullPiece({
          serviceURL: target.serviceURL,
          commit: saved.commit as Commit,
          sourceUrl,
        })
        save({ ...saved, pulled: true })
      }
    } catch (error) {
      if (ctx.signal?.aborted) throw error
      save(withFailure(saved, error))
      ctx.progress?.({
        phase: 'copying',
        message: `Second copy failed: ${messageOf(error)}`,
      })
      continue
    }

    const signed = saved.commit as Commit
    const target = fromSaved(saved.placement as SavedPlacement)
    ctx.progress?.({
      phase: 'copying',
      message:
        signed.kind === 'createDataSetAndAddPieces'
          ? `Creating data set and adding the second copy on provider ${target.providerId}`
          : `Adding the second copy on provider ${target.providerId}`,
    })
    const submission = await backend.submitCommit({
      serviceURL: target.serviceURL,
      commit: signed,
    })
    save({ ...saved, transactionHash: submission.transactionHash })
  }
  return {
    op,
    ...(saved.copy ? { copy: saved.copy } : {}),
    failures: saved.failures,
  }
}

/**
 * Copies requested and failed tries of a finished put, for its output.
 * Puts saved by `filecoin` 0.7.0 and earlier asked for one copy.
 */
export function copyReport(op: Operation): {
  requestedCopies: number
  copyFailures?: CopyFailure[]
} {
  const failures = op.checkpoint.secondary?.failures ?? []
  return {
    requestedCopies: op.input.copies ?? 1,
    ...(failures.length > 0 ? { copyFailures: failures } : {}),
  }
}

/**
 * Whether a put asked for the second copy. Puts saved by `filecoin` 0.7.0
 * and earlier did not, and their quote priced one copy.
 */
function wantsSecondary(op: Operation): boolean {
  return (op.input.copies ?? 1) >= REQUESTED_COPIES
}

/**
 * Forget a saved second placement on the first copy's provider. A put that
 * stopped at the funds check saved the second placement but not the first,
 * so a resume can choose that same provider for the first copy. A signed
 * commit is kept: it is signed only after the first copy confirms.
 */
function apart(
  saved: SecondaryCheckpoint,
  primary: Placement
): SecondaryCheckpoint {
  if (
    saved.commit ||
    saved.placement?.providerId !== primary.providerId.toString()
  ) {
    return saved
  }
  const { placement: _, pulled: __, ...rest } = saved
  return rest
}

/** Save the second copy's checkpoint, and the phase when given. */
function persist(
  ctx: JobContext,
  op: Operation,
  secondary: SecondaryCheckpoint,
  phase?: Operation['phase']
): Operation {
  return updateOperation(ctx.db, op.id, {
    checkpoint: { secondary },
    ...(phase ? { phase } : {}),
  })
}

/**
 * Record a failed try and forget its provider, commit, and pull. Gives up
 * after {@link MAX_ATTEMPTS} failures.
 */
function withFailure(
  saved: SecondaryCheckpoint,
  error: unknown
): SecondaryCheckpoint {
  const failures = [
    ...saved.failures,
    {
      ...(saved.placement ? { providerId: saved.placement.providerId } : {}),
      error: messageOf(error),
    },
  ]
  return {
    failures,
    ...(failures.length >= MAX_ATTEMPTS ? { exhausted: true } : {}),
  }
}

/** Give up because no other provider answers. */
function noProviderLeft(saved: SecondaryCheckpoint): SecondaryCheckpoint {
  return {
    failures: [
      ...saved.failures,
      { error: 'No other approved provider is reachable.' },
    ],
    exhausted: true,
  }
}

/** Provider IDs a new try must not pick. */
function excluded(saved: SecondaryCheckpoint, primary: Placement): bigint[] {
  const ids = new Set([primary.providerId])
  for (const failure of saved.failures) {
    if (failure.providerId) ids.add(BigInt(failure.providerId))
  }
  return [...ids]
}

/** Save a placement as JSON. */
function toSaved(placement: Placement): SavedPlacement {
  return {
    providerId: placement.providerId.toString(),
    serviceURL: placement.serviceURL,
    payee: placement.payee,
    ...(placement.dataSetId == null || placement.clientDataSetId == null
      ? {}
      : {
          dataSetId: placement.dataSetId.toString(),
          clientDataSetId: placement.clientDataSetId.toString(),
        }),
  }
}

/** Rebuild a saved placement. */
function fromSaved(saved: SavedPlacement): Placement {
  return {
    providerId: BigInt(saved.providerId),
    serviceURL: saved.serviceURL,
    payee: saved.payee as Address,
    ...(saved.dataSetId && saved.clientDataSetId
      ? {
          dataSetId: BigInt(saved.dataSetId),
          clientDataSetId: BigInt(saved.clientDataSetId),
        }
      : {}),
  }
}

/** The resource copy of a confirmed second copy. */
function toCopy(
  placement: SavedPlacement,
  landed: { dataSetId: bigint; pieceId: bigint }
): Copy {
  return {
    providerId: placement.providerId,
    dataSetId: landed.dataSetId.toString(),
    pieceId: landed.pieceId.toString(),
    serviceURL: placement.serviceURL,
  }
}

/** Message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

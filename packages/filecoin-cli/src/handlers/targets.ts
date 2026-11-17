import {
  ApiError,
  type PieceWithDataSet,
  unwrap,
} from '@filecoin-project/api-client'
import * as Piece from '@filoz/synapse-core/piece'
import { CliError } from 'clipact'
import { CID } from 'multiformats/cid'
import { apiClientFor } from '../api.ts'
import type { App } from '../app.ts'
import { invalidInput } from '../errors.ts'
import type { AccountScope } from '../state/resources.ts'

/** The most pieces one read returns, filecoin-api's largest page. */
export const PIECE_LIMIT = 200

/** What an `inspect` or `delete` target names. */
export type Target =
  | { kind: 'ref'; ref: string }
  | { kind: 'piece'; dataSetId: string; pieceId: string }
  | { kind: 'pieceCid'; pieceCid: string }
  | { kind: 'rootCid'; rootCid: string }

/**
 * Tell a ref, a `<dataSetId>/<pieceId>` pair, a PieceCID, and a root CID
 * apart, in the order `get` does. A root CID is normalized to CIDv1, the form
 * filecoin-api and Curio name roots in.
 */
export function parseTarget(target: string): Target {
  if (target.startsWith('res_')) return { kind: 'ref', ref: target }
  const pair = /^(\d+)\/(\d+)$/.exec(target)
  if (pair?.[1] && pair[2]) {
    return { kind: 'piece', dataSetId: pair[1], pieceId: pair[2] }
  }
  const pieceCid = Piece.tryFrom(target)?.toString()
  if (pieceCid) return { kind: 'pieceCid', pieceCid }
  try {
    return { kind: 'rootCid', rootCid: CID.parse(target).toV1().toString() }
  } catch {
    throw invalidInput(
      `${target} is not a resource ref, PieceCID, root CID, or <dataSetId>/<pieceId>.`,
      'target'
    )
  }
}

/**
 * The payer's pieces with a PieceCID or an `ipfsRootCID` metadata value, from
 * filecoin-api `/pieces`. Removed pieces are included.
 */
export async function piecesByCid(
  app: App,
  scope: AccountScope,
  filter: { cid: string } | { ipfs_cid: string }
): Promise<PieceWithDataSet[]> {
  const page = unwrap(
    await apiClientFor(app).GET('/{network}/pieces', {
      params: {
        path: { network: app.network },
        query: { owner: scope.payer, limit: PIECE_LIMIT, ...filter },
      },
    })
  )
  return page.data
}

/**
 * One piece by data set and piece ID, with its data set's owner and provider.
 * The single-piece route has neither, so the data set is read in parallel.
 * Returns `undefined` when filecoin-api has no such piece, or another wallet
 * pays for its data set.
 */
export async function pieceById(
  app: App,
  scope: AccountScope,
  dataSetId: string,
  pieceId: string
): Promise<PieceWithDataSet | undefined> {
  const api = apiClientFor(app)
  const missing = (error: unknown) => {
    if (ApiError.isNotFound(error)) return undefined
    throw error
  }
  const [piece, dataSet] = await Promise.all([
    api
      .GET('/{network}/data-sets/{dataSetId}/pieces/{pieceId}', {
        params: { path: { network: app.network, dataSetId, pieceId } },
      })
      .then(unwrap)
      .catch(missing),
    api
      .GET('/{network}/data-sets/{dataSetId}', {
        params: { path: { network: app.network, dataSetId } },
      })
      .then(unwrap)
      .catch(missing),
  ])
  if (!piece || !dataSet) return undefined
  const owner = dataSet.data.owner
  if (owner?.toLowerCase() !== scope.payer.toLowerCase()) return undefined
  return { ...piece.data, owner, providerId: dataSet.data.providerId }
}

/**
 * An `invalid_input` for a root CID the payer stored as more than one piece,
 * with a step to run `command` on each PieceCID.
 */
export function ambiguousRoot(
  rootCid: string,
  pieceCids: string[],
  command: 'inspect' | 'delete'
): CliError {
  return new CliError({
    code: 'invalid_input',
    message: `${rootCid} is stored as ${pieceCids.length} different pieces. ${command === 'inspect' ? 'Inspect' : 'Delete'} one PieceCID.`,
    details: [{ path: 'target', message: 'Matches several PieceCIDs' }],
    next: pieceCids.map((pieceCid) => ({
      by: 'agent' as const,
      command: `filecoin ${command} ${pieceCid}`,
      description:
        command === 'inspect'
          ? 'Inspect the copies of this piece'
          : 'Delete the copies of this piece',
    })),
  })
}

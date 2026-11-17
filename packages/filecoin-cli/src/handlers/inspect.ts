import {
  ApiError,
  type PieceWithDataSet,
  unwrap,
} from '@filecoin-project/api-client'
import * as Piece from '@filoz/synapse-core/piece'
import { CliError, defineHandler } from 'clipact'
import { CID } from 'multiformats/cid'
import { apiClientFor } from '../api.ts'
import type { App } from '../app.ts'
import { inspect } from '../commands/inspect.ts'
import { invalidInput, notFound } from '../errors.ts'
import {
  type AccountScope,
  findResourcesByCid,
  getResource,
  type Resource,
  resourceRefsByPiece,
} from '../state/resources.ts'
import { resourceUrls, retrievalUrls } from '../storage/urls.ts'
import { accountScope, appFor, findResource } from './context.ts'
import { storedPieces } from './pieces.ts'

/** Milliseconds to wait for the retrieval probe. */
const PROBE_TIMEOUT = 15_000

/** The most pieces one `inspect` reads, filecoin-api's largest page. */
const PIECE_LIMIT = 200

/** What an `inspect` target names. */
type Target =
  | { kind: 'ref'; ref: string }
  | { kind: 'piece'; dataSetId: string; pieceId: string }
  | { kind: 'pieceCid'; pieceCid: string }
  | { kind: 'rootCid'; rootCid: string }

/**
 * Tell a ref, a `<dataSetId>/<pieceId>` pair, a PieceCID, and a root CID
 * apart, in the order `get` does. A root CID is normalized to CIDv1, the form
 * filecoin-api and Curio name roots in.
 */
function parseTarget(target: string): Target {
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
async function piecesByCid(
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
async function pieceById(
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

/** The ref of a resource in local state that `target` names, if any. */
function localRef(
  app: App,
  scope: AccountScope,
  target: Target
): string | undefined {
  if (target.kind === 'ref') return target.ref
  if (target.kind === 'piece') {
    return resourceRefsByPiece(app.db(), scope, target.dataSetId).get(
      target.pieceId
    )
  }
  const cid = target.kind === 'pieceCid' ? target.pieceCid : target.rootCid
  return findResourcesByCid(app.db(), scope, cid)[0]?.ref
}

/**
 * A `not_found` for a target no piece of the payer matches. When local state
 * has a resource for it, the put is likely newer than filecoin-api's index,
 * so the next step inspects the resource by ref.
 */
function notIndexed(
  app: App,
  scope: AccountScope,
  input: string,
  target: Target
): CliError {
  const ref = localRef(app, scope, target)
  return notFound(
    `filecoin-api has no piece ${input} paid for by ${scope.payer}. Its indexer adds a new piece a few minutes after the commit.`,
    ref
      ? {
          by: 'agent',
          command: `filecoin inspect ${ref}`,
          description: 'Inspect the managed resource stored as this piece',
        }
      : {
          by: 'agent',
          command: 'filecoin ls',
          description: "List the wallet's stored pieces",
        }
  )
}

/**
 * An `invalid_input` for a root CID the payer stored as more than one piece,
 * with a step to inspect each PieceCID.
 */
function ambiguousRoot(rootCid: string, pieceCids: string[]): CliError {
  return new CliError({
    code: 'invalid_input',
    message: `${rootCid} is stored as ${pieceCids.length} different pieces. Inspect one PieceCID.`,
    details: [{ path: 'target', message: 'Matches several PieceCIDs' }],
    next: pieceCids.map((pieceCid) => ({
      by: 'agent' as const,
      command: `filecoin inspect ${pieceCid}`,
      description: 'Inspect the copies of this piece',
    })),
  })
}

/**
 * Show what a target names with the payer's pieces filecoin-api has for it:
 *
 * - A ref shows the managed resource from local state and every piece the
 *   payer has with its PieceCID. `pieces` is empty until filecoin-api's
 *   indexer has the put.
 * - A PieceCID or root CID shows the payer's pieces filecoin-api has for it,
 *   by `cid` or by the `ipfsRootCID` metadata.
 * - `<dataSetId>/<pieceId>`, as `ls` prints it, shows that one piece.
 *
 * Any target gets `resource` when exactly one managed resource has a copy at
 * the pieces. Removed pieces are included. With `--check`, send a HEAD
 * request to the piece URL and follow filecoin-api's redirect to the provider.
 * The browser URL of a folder always redirects to inbrowser.link, so probing
 * it proves nothing.
 *
 * @see ../../../../docs/filecoin/architecture.md#piece-and-data-set-reads
 */
export default defineHandler(inspect, async (ctx) => {
  const app = await appFor(ctx)
  const scope = accountScope(app)
  const target = parseTarget(ctx.input.target)

  let resource: Resource | undefined
  let found: PieceWithDataSet[]
  if (target.kind === 'ref') {
    resource = findResource(app, target.ref)
    found = await piecesByCid(app, scope, { cid: resource.pieceCid })
  } else if (target.kind === 'piece') {
    const piece = await pieceById(app, scope, target.dataSetId, target.pieceId)
    found = piece ? [piece] : []
  } else if (target.kind === 'pieceCid') {
    found = await piecesByCid(app, scope, { cid: target.pieceCid })
  } else {
    found = await piecesByCid(app, scope, { ipfs_cid: target.rootCid })
  }
  if (!resource && found.length === 0) {
    throw notIndexed(app, scope, ctx.input.target, target)
  }

  const pieces = storedPieces(app, scope, found)
  if (!resource) {
    const refs = new Set(pieces.flatMap((p) => p.resourceRef ?? []))
    const [ref] = refs
    if (refs.size === 1 && ref) resource = getResource(app.db(), ref, scope)
  }

  const pieceCids = [...new Set(pieces.flatMap((p) => p.pieceCid ?? []))]
  if (target.kind === 'rootCid' && pieceCids.length > 1) {
    throw ambiguousRoot(target.rootCid, pieceCids)
  }
  const [pieceCid] = pieceCids
  const urls = resource
    ? resourceUrls(resource, app.apiUrl)
    : pieceCid
      ? retrievalUrls({
          apiUrl: app.apiUrl,
          chainId: scope.chainId,
          pieceCid,
          rootCid:
            target.kind === 'rootCid'
              ? target.rootCid
              : pieces.find((p) => p.rootCid)?.rootCid,
        })
      : undefined
  const result = {
    network: app.network,
    ...(resource ? { resource } : {}),
    pieces,
    ...(urls ? { urls } : {}),
  }
  if (!ctx.input.check || !urls) return ctx.ok(result)

  const probe = urls.piece
  const response = await fetch(probe, {
    method: 'HEAD',
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(PROBE_TIMEOUT)]),
  }).catch((error: unknown) => {
    if (ctx.signal.aborted) throw error
    return undefined
  })
  return ctx.ok({
    ...result,
    retrieval: {
      url: probe,
      state: response?.ok ? 'ready' : 'unavailable',
      status: response?.status ?? 0,
      checkedAt: new Date().toISOString(),
    },
  })
})

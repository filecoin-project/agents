import type { PieceWithDataSet } from '@filecoin-project/api-client'
import { type CliError, defineHandler } from 'clipact'
import type { App } from '../app.ts'
import { inspect } from '../commands/inspect.ts'
import { notFound } from '../errors.ts'
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
import {
  ambiguousRoot,
  parseTarget,
  pieceById,
  piecesByCid,
  type Target,
} from './targets.ts'

/** Milliseconds to wait for the retrieval probe. */
const PROBE_TIMEOUT = 15_000

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
    throw ambiguousRoot(target.rootCid, pieceCids, 'inspect')
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

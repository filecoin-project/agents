import { unwrap } from '@filecoin-project/api-client'
import { defineHandler } from 'clipact'
import { apiClientFor, toPiece } from '../api.ts'
import { ls } from '../commands/ls.ts'
import { resourceRefsByCopy } from '../state/resources.ts'
import { getUrl } from '../storage/urls.ts'
import { accountScope, appFor } from './context.ts'

/** A piece metadata value when it is a non-empty string. */
function text(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * List the payer's pieces across all its data sets from filecoin-api, newest
 * first. The CLI's cursor is filecoin-api's, passed through unchanged.
 * Without `--all`, removed pieces are left out. Each piece that a managed
 * resource has a copy at gets that resource's ref from local state, so
 * pieces stored from another machine or tool are listed too, without a ref.
 *
 * @see ../../../../docs/filecoin/architecture.md#piece-and-data-set-reads
 */
export default defineHandler(ls, async (ctx) => {
  const app = await appFor(ctx)
  const scope = accountScope(app)
  const page = unwrap(
    await apiClientFor(app).GET('/{network}/pieces', {
      params: {
        path: { network: app.network },
        query: {
          owner: scope.payer,
          limit: ctx.input.limit,
          ...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
          ...(ctx.input.provider ? { provider_id: ctx.input.provider } : {}),
          ...(ctx.input.all ? {} : { removed: 'false' as const }),
        },
      },
    })
  )
  const refs = resourceRefsByCopy(
    app.db(),
    scope,
    page.data.map((piece) => piece.dataSetId)
  )
  return ctx.ok({
    network: app.network,
    pieces: page.data.map((piece) => {
      const { pieceId, ...rest } = toPiece(piece)
      const rootCid = text(rest.metadata, 'ipfsRootCID')
      const name = text(rest.metadata, 'name')
      const cid = rootCid ?? rest.pieceCid
      const resourceRef = refs.get(`${piece.dataSetId}/${pieceId}`)
      return {
        dataSetId: piece.dataSetId,
        pieceId,
        ...(piece.providerId ? { providerId: piece.providerId } : {}),
        ...rest,
        ...(rootCid ? { rootCid } : {}),
        ...(name ? { name } : {}),
        ...(cid ? { url: getUrl(app.apiUrl, app.network, cid, true) } : {}),
        ...(resourceRef ? { resourceRef } : {}),
      }
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  })
})

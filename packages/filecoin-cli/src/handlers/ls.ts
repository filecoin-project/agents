import { unwrap } from '@filecoin-project/api-client'
import { defineHandler } from 'clipact'
import { apiClientFor } from '../api.ts'
import { ls } from '../commands/ls.ts'
import { accountScope, appFor } from './context.ts'
import { storedPieces } from './pieces.ts'

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
    await apiClientFor(app).GET('/v1/{network}/pieces', {
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
  return ctx.ok({
    network: app.network,
    pieces: storedPieces(app, scope, page.data),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  })
})

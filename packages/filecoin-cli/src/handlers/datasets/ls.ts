import { unwrap } from '@filecoin-project/api-client'
import { defineHandler } from 'clipact'
import { apiClientFor, toDataSet } from '../../api.ts'
import { ls } from '../../commands/datasets/ls.ts'
import { accountScope, appFor } from '../context.ts'

/**
 * List the payer's data sets from filecoin-api, newest ID first. The CLI's
 * cursor is filecoin-api's, passed through unchanged. Without `--all`, data
 * sets deleted on chain are left out.
 *
 * @see ../../../../../docs/filecoin/architecture.md#data-set-reads
 */
export default defineHandler(ls, async (ctx) => {
  const app = await appFor(ctx)
  const { payer } = accountScope(app)
  const page = unwrap(
    await apiClientFor(app).GET('/{network}/data-sets', {
      params: {
        path: { network: app.network },
        query: {
          owner: payer,
          limit: ctx.input.limit,
          ...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
          ...(ctx.input.provider ? { provider_id: ctx.input.provider } : {}),
          ...(ctx.input.all ? {} : { deleted: 'false' as const }),
        },
      },
    })
  )
  return ctx.ok({
    network: app.network,
    dataSets: page.data.map(toDataSet),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  })
})

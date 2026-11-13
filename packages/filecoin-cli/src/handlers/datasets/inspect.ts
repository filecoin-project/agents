import { ApiError, unwrap } from '@filecoin-project/api-client'
import { defineHandler } from 'clipact'
import { apiClientFor, toDataSet, toPiece } from '../../api.ts'
import { inspect } from '../../commands/datasets/inspect.ts'
import { notFound } from '../../errors.ts'
import { resourceRefsByPiece } from '../../state/resources.ts'
import { accountScope, appFor } from '../context.ts'

/**
 * Show one of the payer's data sets from filecoin-api with a page of its
 * pieces and its provider. Each piece that a managed resource is stored as
 * gets that resource's ref from local state. A data set that filecoin-api
 * does not have, or that another wallet pays for, is `not_found`.
 *
 * @see ../../../../../docs/filecoin/architecture.md#data-set-reads
 */
export default defineHandler(inspect, async (ctx) => {
  const app = await appFor(ctx)
  const scope = accountScope(app)
  const api = apiClientFor(app)
  const path = { network: app.network, dataSetId: ctx.input.id }
  const [dataSet, pieces] = await Promise.all([
    api
      .GET('/{network}/data-sets/{dataSetId}', { params: { path } })
      .then(unwrap)
      .catch((error: unknown) => {
        if (ApiError.isNotFound(error)) return undefined
        throw error
      }),
    api
      .GET('/{network}/data-sets/{dataSetId}/pieces', {
        params: {
          path,
          query: {
            limit: ctx.input.limit,
            ...(ctx.input.cursor ? { cursor: ctx.input.cursor } : {}),
            ...(ctx.input.removed ? {} : { removed: 'false' as const }),
          },
        },
      })
      .then(unwrap),
  ])
  if (
    !dataSet ||
    dataSet.data.owner?.toLowerCase() !== scope.payer.toLowerCase()
  ) {
    throw notFound(
      `filecoin-api has no data set ${ctx.input.id} paid for by ${scope.payer}. A data set created in the last few minutes may not be indexed yet.`,
      {
        by: 'agent',
        command: 'filecoin datasets ls',
        description: "List the wallet's data sets",
      }
    )
  }
  const providerId = dataSet.data.providerId
  const provider = providerId
    ? await api
        .GET('/{network}/providers/{providerId}', {
          params: { path: { network: app.network, providerId } },
        })
        .then(unwrap)
        .catch((error: unknown) => {
          if (ApiError.isNotFound(error)) return undefined
          throw error
        })
    : undefined
  const refs = resourceRefsByPiece(app.db(), scope, ctx.input.id)
  return ctx.ok({
    network: app.network,
    dataSet: toDataSet(dataSet.data),
    ...(provider
      ? {
          provider: {
            providerId: provider.data.providerId,
            ...(provider.data.name ? { name: provider.data.name } : {}),
            ...(provider.data.serviceUrl
              ? { serviceURL: provider.data.serviceUrl }
              : {}),
          },
        }
      : {}),
    pieces: pieces.data.map((piece) => {
      const resourceRef = refs.get(piece.pieceId)
      return { ...toPiece(piece), ...(resourceRef ? { resourceRef } : {}) }
    }),
    ...(pieces.nextCursor ? { nextCursor: pieces.nextCursor } : {}),
  })
})

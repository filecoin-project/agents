import {
  ApiError,
  type PieceWithDataSet,
  unwrap,
} from '@filecoin-project/api-client'
import { defineHandler } from 'clipact'
import { apiClientFor } from '../api.ts'
import type { App } from '../app.ts'
import { RM_SCOPES } from '../auth/scopes.ts'
import { openSession } from '../auth/session.ts'
import { remove } from '../commands/delete.ts'
import { invalidInput, notFound } from '../errors.ts'
import { APPLICATION_SOURCE } from '../source.ts'
import {
  type AccountScope,
  findResourcesByCid,
  getResource,
  type Resource,
  resourceRefsByPiece,
} from '../state/resources.ts'
import {
  planRemoval,
  type RemovalCandidate,
  reportRemoval,
  startRemove,
} from '../storage/jobs.ts'
import { createSynapseBackend } from '../storage/synapse.ts'
import { accountScope, appFor, findResource, jobContext } from './context.ts'
import {
  allPiecesByCid,
  ambiguousRoot,
  parseTarget,
  pieceById,
  type Target,
} from './targets.ts'

/** `<dataSetId>/<pieceId>` of a copy or piece. */
function keyOf(copy: { dataSetId: string; pieceId: string }): string {
  return `${copy.dataSetId}/${copy.pieceId}`
}

/**
 * Read a value per ID from filecoin-api in parallel. An ID filecoin-api
 * doesn't have maps to `undefined`.
 */
async function readEach<T>(
  ids: string[],
  read: (id: string) => Promise<T | undefined>
): Promise<Map<string, T | undefined>> {
  const unique = [...new Set(ids)]
  const values = await Promise.all(
    unique.map((id) =>
      read(id).catch((error: unknown) => {
        if (ApiError.isNotFound(error)) return undefined
        throw error
      })
    )
  )
  return new Map(unique.map((id, index) => [id, values[index]]))
}

/**
 * The copies of pieces filecoin-api has for the target, with each
 * provider's service URL from `/providers/{id}` and each data set's `source`
 * from `/data-sets/{id}`.
 */
async function indexedCopies(
  app: App,
  pieces: PieceWithDataSet[]
): Promise<RemovalCandidate[]> {
  const api = apiClientFor(app)
  const network = app.network
  const providerIds = pieces.map((piece) => {
    if (!piece.providerId) {
      throw notFound(
        `filecoin-api has no provider for data set ${piece.dataSetId} yet.`
      )
    }
    return piece.providerId
  })
  const [urls, sources] = await Promise.all([
    readEach(providerIds, async (providerId) => {
      const provider = await api
        .GET('/{network}/providers/{providerId}', {
          params: { path: { network, providerId } },
        })
        .then(unwrap)
      return provider.data.serviceUrl ?? undefined
    }),
    readEach(
      pieces.map((piece) => piece.dataSetId),
      async (dataSetId) => {
        const dataSet = await api
          .GET('/{network}/data-sets/{dataSetId}', {
            params: { path: { network, dataSetId } },
          })
          .then(unwrap)
        return dataSet.data.source ?? undefined
      }
    ),
  ])
  return pieces.map((piece, index) => {
    const providerId = providerIds[index] as string
    const serviceURL = urls.get(providerId)
    if (!serviceURL) {
      throw notFound(
        `filecoin-api has no service URL for provider ${providerId}.`
      )
    }
    const source = sources.get(piece.dataSetId)
    return {
      providerId,
      dataSetId: piece.dataSetId,
      pieceId: piece.pieceId,
      serviceURL,
      ...(source ? { source } : {}),
    }
  })
}

/**
 * The copies a PieceCID, root CID, or `<dataSetId>/<pieceId>` names: the
 * payer's pieces filecoin-api has for it that it doesn't show as removed,
 * and the copies of managed resources in local state that match it. Local
 * state covers a put newer than filecoin-api's index. With `provider`, only
 * that provider's copies are kept, before any other provider is looked up.
 */
async function targetCopies(
  app: App,
  scope: AccountScope,
  input: string,
  target: Exclude<Target, { kind: 'ref' }>,
  provider: string | undefined
): Promise<RemovalCandidate[]> {
  const db = app.db()
  let found: PieceWithDataSet[]
  let local: Resource[]
  let matches = (_copy: { dataSetId: string; pieceId: string }) => true
  if (target.kind === 'piece') {
    const piece = await pieceById(app, scope, target.dataSetId, target.pieceId)
    found = piece ? [piece] : []
    const ref = resourceRefsByPiece(db, scope, target.dataSetId).get(
      target.pieceId
    )
    local = ref ? [getResource(db, ref, scope) ?? []].flat() : []
    matches = (copy) => keyOf(copy) === keyOf(target)
  } else if (target.kind === 'pieceCid') {
    found = await allPiecesByCid(app, scope, { cid: target.pieceCid })
    local = findResourcesByCid(db, scope, target.pieceCid)
  } else {
    found = await allPiecesByCid(app, scope, { ipfs_cid: target.rootCid })
    local = findResourcesByCid(db, scope, target.rootCid)
    const pieceCids = new Set([
      ...found.flatMap((piece) => piece.cid ?? []),
      ...local.map((resource) => resource.pieceCid),
    ])
    if (pieceCids.size > 1) {
      throw ambiguousRoot(target.rootCid, [...pieceCids], 'delete')
    }
  }

  const copies = new Map<string, RemovalCandidate>()
  for (const resource of local) {
    for (const copy of resource.copies.filter(matches)) {
      copies.set(keyOf(copy), {
        ...copy,
        resourceRef: resource.ref,
        source: APPLICATION_SOURCE,
      })
    }
  }
  const stored = found.filter(
    (piece) => !piece.removed && !copies.has(keyOf(piece))
  )
  const onProvider = (copy: { providerId?: string | null }) =>
    !provider || copy.providerId === provider
  const kept = [...copies.values()].filter(onProvider)
  const keptStored = stored.filter(onProvider)
  if (
    kept.length + keptStored.length === 0 &&
    copies.size + stored.length > 0
  ) {
    throw notOnProvider(input, provider as string)
  }
  kept.push(...(await indexedCopies(app, keptStored)))
  if (kept.length > 0) return kept
  if (found.length > 0) {
    throw invalidInput(`Every copy of ${input} is already removed.`, 'target')
  }
  throw notFound(
    `filecoin-api has no piece ${input} paid for by ${scope.payer}, and no managed resource matches it. Its indexer adds a new piece a few minutes after the commit.`,
    {
      by: 'agent',
      command: 'filecoin ls',
      description: "List the wallet's stored pieces",
    }
  )
}

/** A `not_found` for a target with no copy on `provider`. */
function notOnProvider(input: string, provider: string) {
  return notFound(`No copy of ${input} is on provider ${provider}.`, {
    by: 'agent',
    command: `filecoin delete ${input} --dry-run`,
    description: 'List the copies and their providers',
  })
}

/**
 * The copies a target names, narrowed to one provider with `--provider`. A
 * ref names its resource's copies in local state, which are in data sets
 * that `filecoin` created.
 */
async function copiesOf(
  app: App,
  input: string,
  provider: string | undefined
): Promise<RemovalCandidate[]> {
  const target = parseTarget(input)
  let copies: RemovalCandidate[]
  if (target.kind === 'ref') {
    const resource = findResource(app, target.ref)
    if (resource.status !== 'active') {
      throw invalidInput(`${target.ref} is already pending removal.`, 'target')
    }
    copies = resource.copies.map((copy) => ({
      ...copy,
      resourceRef: resource.ref,
      source: APPLICATION_SOURCE,
    }))
  } else {
    return await targetCopies(app, accountScope(app), input, target, provider)
  }
  if (!provider) return copies
  const kept = copies.filter((copy) => copy.providerId === provider)
  if (kept.length === 0) throw notOnProvider(input, provider)
  return kept
}

/**
 * Schedule removal of the copies a ref, PieceCID, root CID, or
 * `<dataSetId>/<pieceId>` names. filecoin-api finds the copies a CID or pair
 * names, and the chain decides: each copy is checked before anything is
 * signed, and copies already scheduled for removal or removed are skipped.
 * With `--dry-run`, report the copies and their state without signing.
 *
 * @see ../../../../docs/filecoin/architecture.md#the-delete-flow
 */
export default defineHandler(remove, async (ctx) => {
  const app = await appFor(ctx)
  const options = {
    target: ctx.input.target,
    providerId: ctx.input.provider,
    copies: await copiesOf(app, ctx.input.target, ctx.input.provider),
  }
  if (ctx.dryRun) {
    const sessionKey = openSession(app)
    const removals = await planRemoval(
      {
        backend: createSynapseBackend(app, sessionKey),
        payer: sessionKey.rootAddress,
      },
      options
    )
    const refs = new Set(removals.flatMap((r) => r.resourceRef ?? []))
    return ctx.ok({
      dryRun: true,
      target: options.target,
      removals: removals.map(reportRemoval),
      resources: [...refs].flatMap((ref) => getResource(app.db(), ref) ?? []),
    })
  }
  const job = await jobContext(app, RM_SCOPES, ctx)
  return ctx.ok({ dryRun: false, ...(await startRemove(job, options)) })
})

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { parseRetrievalCid, type RetrievalCid } from '../cid.ts'
import { type Db, type DbFactory, type DbStats, openNetworkDb } from '../db.ts'
import { notFound } from '../errors.ts'
import {
  DEFAULT_IPNI_URL,
  findIpniProviders,
  type IpniOptions,
  type IpniProvider,
} from '../ipni.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import { NETWORKS, type Network, type NetworkName } from '../networks.ts'
import { findIpfsRootProvider, findPieceProvider } from '../queries/pieces.ts'
import {
  type ActiveProvider,
  listActiveProviders,
} from '../queries/providers.ts'
import {
  BooleanQuery,
  ErrorSchema,
  errorResponses,
  NetworkSchema,
  notFoundResponse,
  RetrievalCidInput,
  rateLimitHeaders,
  UintInput,
} from '../schemas/common.ts'
import { type CacheStatus, staleWhileRevalidate } from '../swr-cache.ts'
import { activeSpan, setAttributes } from '../tracing.ts'
import type { AppEnv } from '../types.ts'
import { validationHook } from './hook.ts'

/** How long a resolved provider is served without revalidating. */
export const PROVIDER_FRESH_MS = 10 * 60_000

/** How long a resolved provider stays cached and may be served stale. */
export const PROVIDER_MAX_AGE_S = 24 * 60 * 60

/**
 * Service Worker IPFS gateway that verifies content in the browser.
 *
 * @see https://inbrowser.link
 */
export const INBROWSER_URL = 'https://inbrowser.link'

/** Cache-Control for redirects to a provider, which can change. */
export const PROVIDER_REDIRECT_CACHE_CONTROL = 'public, max-age=60'

/** Cache-Control for redirects to inbrowser.link, which never change. */
const GATEWAY_REDIRECT_CACHE_CONTROL = 'public, max-age=86400'

/** Query parameters consumed by the route rather than forwarded. */
const OWN_PARAMS = new Set(['network', 'browser', 'provider'])

/** Where a redirect target came from: the indexer, the `provider` hint or IPNI. */
export type RetrievalSource = 'index' | 'hint' | 'ipni'

/** Where `GET /get/{cid}` redirects, and how the route found it. */
export interface RetrievalTarget {
  source: RetrievalSource
  /** Registry provider ID, or `null` for an IPNI provider outside the registry. */
  providerId: string | null
  /** Base URL that `piece/{cid}` or `ipfs/{cid}` is appended to. */
  serviceUrl: string
  /** `ipfsRootCID` of an indexed copy in an IPFS-indexed data set, else `null`. */
  ipfsRootCid: string | null
}

const route = createRoute({
  operationId: 'retrieve',
  method: 'get',
  path: '/get/{cid}',
  tags: ['Retrieval'],
  summary: 'Redirect to where content can be retrieved',
  description: [
    'Redirects a PieceCID to `/piece/{cid}` on a storage provider serving it,',
    'or with `browser=true` to inbrowser.link when the piece has `ipfsRootCID`',
    'metadata in an IPFS-indexed data set.',
    'Redirects any other CID to `/ipfs/{cid}` on a provider with a piece',
    'whose `ipfsRootCID` metadata matches, or to inbrowser.link with',
    '`browser=true`.',
    'When the indexer has no copy, `provider` names the provider to redirect',
    'to instead. Without a usable hint, the route looks the CID up in IPNI',
    '(cid.contact) and redirects to a provider that serves it over https,',
    'including providers outside Filecoin Warm Storage.',
    'Other query parameters are forwarded.',
  ].join(' '),
  request: {
    params: z.object({
      cid: RetrievalCidInput.openapi({ param: { name: 'cid', in: 'path' } }),
    }),
    query: z.object({
      network: NetworkSchema.default('mainnet'),
      browser: BooleanQuery.optional().openapi({
        description:
          'Open IPFS content, or a piece with an IPFS root, in the browser through inbrowser.link',
      }),
      provider: UintInput.optional().openapi({
        description:
          'Provider ID to redirect to when no indexed copy exists yet, such as a piece the provider has but has not committed on chain',
      }),
    }),
  },
  responses: {
    302: {
      description: 'Redirect to the retrieval URL',
      headers: {
        ...rateLimitHeaders,
        Location: { description: 'Retrieval URL', schema: { type: 'string' } },
        'X-Cache': {
          description: 'Provider cache status: hit, stale, miss or none',
          schema: { type: 'string' },
        },
        'X-Source': {
          description:
            'Where the provider came from: index, hint or ipni. Absent for a redirect to inbrowser.link without a lookup',
          schema: { type: 'string' },
        },
      },
    },
    400: errorResponses[400],
    ...notFoundResponse,
    429: errorResponses[429],
    502: {
      description: 'IPNI lookup failed after the indexer had no copy',
      headers: rateLimitHeaders,
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

/**
 * URL for `path` under `base`, keeping any base path, with the request's
 * query parameters other than the route's own.
 */
export function retrievalUrl(
  base: string,
  path: string,
  query: URLSearchParams
): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`)
  for (const [key, value] of query) {
    if (!OWN_PARAMS.has(key)) url.searchParams.append(key, value)
  }
  return url.toString()
}

/** Cache key of a resolved {@link RetrievalTarget}. */
export function targetCacheKey(
  origin: string,
  network: NetworkName,
  cid: RetrievalCid
): string {
  return new URL(`/__cache/v3/${network}/${cid.kind}/${cid.cid}`, origin).href
}

/** Cache key of a network's {@link ActiveProvider} list. */
export function providersCacheKey(
  origin: string,
  network: NetworkName
): string {
  return new URL(`/__cache/v3/${network}/providers`, origin).href
}

/** Where and how the route's lookups run for one request. */
interface Lookup {
  env: AppEnv['Bindings']
  network: NetworkName
  dbFactory: DbFactory
  stats: DbStats
  /** Origin of the request, for cache keys. */
  origin: string
  ipni: IpniOptions
  waitUntil: (promise: Promise<unknown>) => void
  /** Close connections after the response instead of waiting for them. */
  inRequest: boolean
}

/**
 * Run `find` on the network's database. Returns `undefined` when the
 * network has no database binding, so the route can still ask IPNI.
 */
async function queryDb<T>(
  lookup: Lookup,
  find: (db: Db, network: Network) => Promise<T>
): Promise<T | undefined> {
  const { env, network, dbFactory, stats } = lookup
  const opened = openNetworkDb(env, network, dbFactory, stats)
  if (!opened) return undefined
  try {
    return await find(opened.db, opened.network)
  } finally {
    if (lookup.inRequest) lookup.waitUntil(opened.close())
    else await opened.close()
  }
}

/** The best indexed copy of a CID, if the indexer has one. */
async function indexedTarget(
  lookup: Lookup,
  cid: RetrievalCid
): Promise<RetrievalTarget | undefined> {
  const find = cid.kind === 'piece' ? findPieceProvider : findIpfsRootProvider
  const provider = await queryDb(lookup, (db, network) =>
    find(db, network, cid.cid)
  )
  return provider && { source: 'index', ...provider }
}

/**
 * The network's active providers, cached with stale-while-revalidate. Empty
 * when the network has no database binding.
 */
async function activeProviders(lookup: Lookup): Promise<ActiveProvider[]> {
  const { value } = await staleWhileRevalidate({
    cache: caches.default,
    key: providersCacheKey(lookup.origin, lookup.network),
    freshMs: PROVIDER_FRESH_MS,
    maxAgeSeconds: PROVIDER_MAX_AGE_S,
    load: () => queryDb(lookup, listActiveProviders),
    revalidate: () => queryDb(inBackground(lookup), listActiveProviders),
    waitUntil: lookup.waitUntil,
  })
  return value ?? []
}

/**
 * Rank IPNI providers: those in the registry first, endorsed and then
 * approved ahead of the rest, then IPNI's order. Returns the first, with the
 * registry's service URL when it matches, or `undefined` when there is none.
 */
export function rankIpniProviders(
  found: IpniProvider[],
  registry: ActiveProvider[]
): RetrievalTarget | undefined {
  const byHost = new Map<string, ActiveProvider>()
  for (const provider of registry) {
    if (!byHost.has(provider.host)) byHost.set(provider.host, provider)
  }
  const score = (match: ActiveProvider | undefined) =>
    match ? (match.endorsed ? 0 : match.approved ? 1 : 2) : 3
  const [best] = found
    .map((provider, order) => ({
      provider,
      order,
      match: byHost.get(provider.host),
    }))
    .sort((a, b) => score(a.match) - score(b.match) || a.order - b.order)
  if (!best) return undefined
  return {
    source: 'ipni',
    providerId: best.match?.providerId ?? null,
    serviceUrl: best.match?.serviceUrl ?? best.provider.origin,
    ipfsRootCid: null,
  }
}

/** Rank the providers of an IPNI lookup against the network's registry. */
async function ipniTarget(
  lookup: Lookup,
  lookupPromise: Promise<IpniProvider[]>
): Promise<RetrievalTarget | undefined> {
  const found = await lookupPromise
  if (found.length === 0) return undefined
  return rankIpniProviders(found, await activeProviders(lookup))
}

/**
 * Resolve a CID by racing the indexer with IPNI. The indexer answer wins
 * whenever it has a copy, because it knows which copies are live and ranks
 * them; the IPNI request is then aborted. Otherwise the IPNI answer is used,
 * and an IPNI failure throws.
 */
async function raceTarget(
  lookup: Lookup,
  cid: RetrievalCid
): Promise<RetrievalTarget | undefined> {
  const controller = new AbortController()
  const ipni = findIpniProviders(cid, {
    ...lookup.ipni,
    signal: controller.signal,
  })
  // Handled below, or dropped when the indexer answers first.
  ipni.catch(() => undefined)
  let indexed: RetrievalTarget | undefined
  try {
    indexed = await indexedTarget(lookup, cid)
  } catch (error) {
    controller.abort()
    throw error
  }
  if (indexed) {
    controller.abort()
    return indexed
  }
  return ipniTarget(lookup, ipni)
}

/**
 * Resolve a CID with the indexer first and IPNI only on a miss, for the
 * background revalidation, which has no caller waiting.
 */
async function sequentialTarget(
  lookup: Lookup,
  cid: RetrievalCid
): Promise<RetrievalTarget | undefined> {
  const indexed = await indexedTarget(lookup, cid)
  if (indexed) return indexed
  return ipniTarget(lookup, findIpniProviders(cid, lookup.ipni))
}

/** A copy of `lookup` for work after the response, with its own totals. */
function inBackground(lookup: Lookup): Lookup {
  return { ...lookup, stats: newStats(), inRequest: false }
}

/**
 * `GET /get/{cid}`: redirect a PieceCID or IPFS CID to a server that has it,
 * without proxying the content. The indexer's ranked copies come first. A
 * `provider` hint comes next, and IPNI last. Without a hint the route races
 * the indexer with IPNI and prefers the indexer. Answers from the indexer and
 * IPNI are cached per network and CID with stale-while-revalidate; hints
 * and misses are not.
 *
 * @see https://github.com/filecoin-project/curio/blob/main/documentation/en/curio-market/retrievals.md
 * @see ../../../../docs/filecoin/retrieval.md
 */
export function retrievalRoutes(
  dbFactory: DbFactory,
  ipniFetch: typeof fetch = (input, init) => fetch(input, init)
) {
  const api = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })
  api.use('/get/*', rateLimit('RATE_LIMIT_API'))

  api.openapi(route, async (c) => {
    const { cid } = c.req.valid('param')
    const { network, browser, provider: hint } = c.req.valid('query')
    const query = new URL(c.req.url).searchParams
    const span = activeSpan()
    setAttributes(span, { 'filecoin.cid.kind': cid.kind })

    if (cid.kind === 'ipfs' && browser) {
      c.header('Cache-Control', GATEWAY_REDIRECT_CACHE_CONTROL)
      c.header('X-Cache', 'none')
      return c.redirect(
        retrievalUrl(INBROWSER_URL, `ipfs/${cid.cid}`, query),
        302
      )
    }

    c.set('network', NETWORKS[network])
    const lookup: Lookup = {
      env: c.env,
      network,
      dbFactory,
      stats: c.var.dbStats,
      origin: new URL(c.req.url).origin,
      ipni: { url: c.env.IPNI_URL || DEFAULT_IPNI_URL, fetch: ipniFetch },
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      inRequest: true,
    }
    const cached = (load: () => Promise<RetrievalTarget | undefined>) =>
      staleWhileRevalidate({
        cache: caches.default,
        key: targetCacheKey(lookup.origin, network, cid),
        freshMs: PROVIDER_FRESH_MS,
        maxAgeSeconds: PROVIDER_MAX_AGE_S,
        load,
        revalidate: () => sequentialTarget(inBackground(lookup), cid),
        waitUntil: lookup.waitUntil,
      })

    let target: RetrievalTarget | undefined
    let status: CacheStatus
    if (hint === undefined) {
      ;({ value: target, status } = await cached(() => raceTarget(lookup, cid)))
    } else {
      // A hint skips the race: it is the answer whenever the indexer misses.
      ;({ value: target, status } = await cached(() =>
        indexedTarget(lookup, cid)
      ))
      if (!target) {
        const hinted = (await activeProviders(lookup)).find(
          (p) => p.providerId === hint
        )
        if (hinted) {
          target = {
            source: 'hint',
            providerId: hinted.providerId,
            serviceUrl: hinted.serviceUrl,
            ipfsRootCid: null,
          }
        } else {
          ;({ value: target, status } = await cached(() =>
            ipniTarget(lookup, findIpniProviders(cid, lookup.ipni))
          ))
        }
      }
    }
    setAttributes(span, {
      'filecoin.cache': status,
      'filecoin.provider_id': target?.providerId ?? undefined,
      'filecoin.retrieval.source': target?.source,
    })
    if (!target) {
      throw notFound(cid.kind === 'piece' ? 'Piece' : 'IPFS content', cid.cid)
    }

    c.header('Cache-Control', PROVIDER_REDIRECT_CACHE_CONTROL)
    c.header('X-Cache', status)
    c.header('X-Source', target.source)
    const root = browser ? ipfsRoot(target.ipfsRootCid) : undefined
    if (root) {
      return c.redirect(retrievalUrl(INBROWSER_URL, `ipfs/${root}`, query), 302)
    }
    // Kinds match Curio's endpoints: `/piece/{cid}` and `/ipfs/{cid}`.
    return c.redirect(
      retrievalUrl(target.serviceUrl, `${cid.kind}/${cid.cid}`, query),
      302
    )
  })

  return api
}

/**
 * Normalized IPFS root CID from piece metadata, or `undefined` when the
 * metadata has none or holds something other than an IPFS CID.
 */
function ipfsRoot(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    const cid = parseRetrievalCid(value)
    return cid.kind === 'ipfs' ? cid.cid : undefined
  } catch {
    return undefined
  }
}

/** Empty {@link DbStats} for work outside the request's own totals. */
function newStats(): DbStats {
  return { queries: 0, ms: 0 }
}

import type { CallToolResult } from '@modelcontextprotocol/server'
import { ApiError } from '../errors.ts'
import { type CacheStatus, staleWhileRevalidate } from '../swr-cache.ts'

/**
 * GitBook's hosted MCP server for docs.filecoin.io.
 *
 * @see https://gitbook.com/docs/ai-for-your-readers/mcp-servers-for-published-docs
 */
export const DOCS_MCP_URL = 'https://docs.filecoin.io/~gitbook/mcp'

/** Age after which a cached search result is refreshed in the background. */
const DOCS_FRESH_MS = 60 * 60 * 1000

/** Seconds a search result stays in the cache; stale entries are served until then. */
const DOCS_MAX_AGE_S = 24 * 60 * 60

/** Time limit for one call to GitBook. */
const DOCS_TIMEOUT_MS = 10_000

/** Content blocks of GitBook's search result, as forwarded to the client. */
export type DocsContent = CallToolResult['content']

/** Dependencies for {@link searchDocs}. */
export interface DocsSearchOptions {
  /** Fetch used to call GitBook; tests inject a fake. */
  fetch: typeof fetch
  /** Cache to store results in, usually `caches.default`. */
  cache: Cache
  /** Origin of the request, used to build an absolute cache key. */
  origin: string
  /** Keep the invocation alive for work after the response. */
  waitUntil: (promise: Promise<unknown>) => void
}

/** A JSON-RPC response to a `tools/call` request. */
interface RpcResponse {
  id?: unknown
  result?: { content?: DocsContent; isError?: boolean }
  error?: { code: number; message: string }
}

/**
 * Search docs.filecoin.io through GitBook's `searchDocumentation` MCP tool.
 * Results are cached per normalized query with stale-while-revalidate, so
 * repeated searches skip GitBook. Failures are not cached.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools
 */
export async function searchDocs(
  query: string,
  options: DocsSearchOptions
): Promise<{ content: DocsContent; status: CacheStatus }> {
  const normalized = normalizeQuery(query)
  const key = new URL(
    `/__cache/v1/docs-search?q=${encodeURIComponent(normalized)}`,
    options.origin
  ).href
  const { value, status } = await staleWhileRevalidate({
    cache: options.cache,
    key,
    freshMs: DOCS_FRESH_MS,
    maxAgeSeconds: DOCS_MAX_AGE_S,
    load: () => callGitBook(normalized, options.fetch),
    waitUntil: options.waitUntil,
  })
  return { content: value ?? [], status }
}

/** Trim, collapse whitespace and lowercase, so equivalent queries share a cache entry. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Call GitBook's MCP server statelessly with one `tools/call` request and
 * return the result's content blocks.
 */
async function callGitBook(
  query: string,
  fetchFn: typeof fetch
): Promise<DocsContent> {
  let res: Response
  try {
    res = await fetchFn(DOCS_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchDocumentation', arguments: { query } },
      }),
      signal: AbortSignal.timeout(DOCS_TIMEOUT_MS),
    })
  } catch (error) {
    throw docsUnavailable(
      error instanceof Error ? error.message : 'fetch failed'
    )
  }
  if (!res.ok) throw docsUnavailable(`GitBook returned ${res.status}`)
  let message: RpcResponse | undefined
  try {
    message = parseRpcResponse(
      await res.text(),
      res.headers.get('Content-Type')
    )
  } catch {
    throw docsUnavailable('GitBook returned an invalid response')
  }
  if (message?.error) throw docsUnavailable(message.error.message)
  if (!message?.result || message.result.isError) {
    throw docsUnavailable('GitBook search failed')
  }
  return message.result.content ?? []
}

/**
 * Parse a Streamable HTTP response body: plain JSON, or a `text/event-stream`
 * whose `data:` lines carry the JSON-RPC response.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#sending-messages-to-the-server
 */
export function parseRpcResponse(
  body: string,
  contentType: string | null
): RpcResponse | undefined {
  if (!contentType?.includes('text/event-stream')) {
    return JSON.parse(body) as RpcResponse
  }
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    const message = JSON.parse(data) as RpcResponse
    if (message.id === 1) return message
  }
  return undefined
}

/** 502 for a docs search that GitBook could not answer. */
function docsUnavailable(reason: string): ApiError {
  return new ApiError(
    502,
    'docs_unavailable',
    `Filecoin docs search is unavailable: ${reason}`
  )
}

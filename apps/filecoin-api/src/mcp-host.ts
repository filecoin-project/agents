import { errorBody } from './errors.ts'
import type { Bindings } from './networks.ts'

/** Anything that serves a request like a Hono app's `fetch`. */
interface FetchApp {
  fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext
  ): Response | Promise<Response>
}

/**
 * Paths an MCP host serves, and the app path each one reaches. `/` and
 * `/server-card` sit where `/mcp` and `/mcp/server-card` sit on the API hosts.
 */
const MCP_HOST_PATHS = new Map([
  ['/', '/mcp'],
  ['/server-card', '/mcp/server-card'],
  ['/.well-known/mcp/server-card.json', '/.well-known/mcp/server-card.json'],
  ['/.well-known/mcp-server-card', '/.well-known/mcp-server-card'],
])

/**
 * Whether `hostname` is one of the hosts in `MCP_HOSTS`, which serve the MCP
 * endpoint at `/`.
 *
 * @param hostname - Request hostname.
 * @param env - Worker bindings.
 */
export function isMcpHost(hostname: string, env: Bindings) {
  return env.MCP_HOSTS.split(',').includes(hostname)
}

/**
 * Public URL of the MCP endpoint: `MCP_PUBLIC_URL` when it is set, as in
 * production. Otherwise, as on Previews and in local dev, the endpoint on the
 * request's host: its root on an MCP host, and `/mcp` on any other host.
 *
 * @param url - Request URL, as the app sees it.
 * @param env - Worker bindings.
 */
export function mcpUrl(url: URL, env: Bindings) {
  if (env.MCP_PUBLIC_URL) return env.MCP_PUBLIC_URL
  return isMcpHost(url.hostname, env) ? url.origin : `${url.origin}/mcp`
}

/**
 * Wrap the app so the hosts in `MCP_HOSTS` serve only the MCP endpoint, at
 * `/`, and its server card. Requests to `/` are rewritten to `/mcp`, so they
 * share its handler, rate limit, CORS, request ids and tracing. Other paths
 * on those hosts get `404`. Every other host reaches the app unchanged.
 *
 * @see ../../../docs/filecoin/mcp-domains.md
 * @see https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
 */
export function withMcpHosts(app: FetchApp) {
  return {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
      const url = new URL(request.url)
      if (!isMcpHost(url.hostname, env)) {
        return app.fetch(request, env, ctx)
      }
      const path = MCP_HOST_PATHS.get(url.pathname)
      if (!path) {
        return Response.json(errorBody('not_found', 'Route not found'), {
          status: 404,
        })
      }
      url.pathname = path
      return app.fetch(new Request(url, request), env, ctx)
    },
  } satisfies ExportedHandler<Bindings>
}

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
 * Wrap the app so the hosts in `MCP_HOSTS` serve only the MCP endpoint, at
 * `/`. Requests to `/` are rewritten to `/mcp`, so they share its handler,
 * rate limit, CORS, request ids and tracing. Other paths on those hosts get
 * `404`. Every other host reaches the app unchanged.
 *
 * @see ../../../docs/filecoin/mcp-domains.md
 * @see https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
 */
export function withMcpHosts(app: FetchApp) {
  return {
    fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
      const url = new URL(request.url)
      if (!env.MCP_HOSTS.split(',').includes(url.hostname)) {
        return app.fetch(request, env, ctx)
      }
      if (url.pathname !== '/') {
        return Response.json(errorBody('not_found', 'Route not found'), {
          status: 404,
        })
      }
      url.pathname = '/mcp'
      return app.fetch(new Request(url, request), env, ctx)
    },
  } satisfies ExportedHandler<Bindings>
}

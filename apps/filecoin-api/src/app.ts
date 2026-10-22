import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { cors } from 'hono/cors'
import { etag } from 'hono/etag'
import { timing } from 'hono/timing'
import { type DbFactory, hyperdriveDb } from './db.ts'
import { errorBody, toErrorResponse } from './errors.ts'
import { checkHealth } from './health.ts'
import { log } from './log.ts'
import { handleMcp } from './mcp/http.ts'
import { buildMcpServer, type McpHandle } from './mcp/server.ts'
import { mcpUrl } from './mcp-host.ts'
import { rateLimit } from './middleware/rate-limit.ts'
import { requestId } from './middleware/request-id.ts'
import { requestTelemetry } from './middleware/telemetry.ts'
import { NETWORK_NAMES } from './networks.ts'
import { validationHook } from './routes/hook.ts'
import { networkRoutes } from './routes/network.ts'
import { retrievalRoutes } from './routes/retrieval.ts'
import {
  mcpServerCard,
  SERVER_CARD_PATHS,
  SERVER_CARD_TYPE,
} from './server-card.ts'
import { activeSpan, recordError } from './tracing.ts'
import type { AppEnv } from './types.ts'

/**
 * API version reported in OpenAPI and MCP server info. release-please writes
 * the release version here and into `openapi.json`.
 *
 * @see https://github.com/googleapis/release-please/blob/main/docs/customizing.md#updating-arbitrary-files
 */
export const VERSION = '0.4.1' // x-release-please-version

/**
 * OpenAPI document settings for a server origin. `/openapi.json` serves the
 * request's origin, and the committed `openapi.json` uses the production one.
 *
 * @param origin - Server URL listed in the document.
 * @see https://github.com/honojs/middleware/tree/main/packages/zod-openapi
 */
export function openApiConfig(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'filecoin-api',
      version: VERSION,
      description:
        'Read-only Filecoin data: storage providers, data sets, pieces, Filecoin Pay rails and session keys.',
    },
    servers: [{ url: origin }],
    tags: [
      { name: 'Status' },
      { name: 'Providers' },
      { name: 'Data sets' },
      { name: 'Pieces' },
      { name: 'Rails' },
      { name: 'Session keys' },
      { name: 'Retrieval' },
    ],
  }
}

/** Options for {@link createApp}. */
export interface AppOptions {
  /** Database client factory; tests inject fakes. */
  dbFactory?: DbFactory
  /** Fetch for the MCP docs search's calls to GitBook; tests inject fakes. */
  docsFetch?: typeof fetch
}

/**
 * Create the filecoin-api Hono app: REST routes under `/{network}`, OpenAPI
 * document, API reference, the MCP endpoint and its server card.
 *
 * @see https://hono.dev/examples/zod-openapi
 */
export function createApp(options: AppOptions = {}) {
  const dbFactory = options.dbFactory ?? hyperdriveDb
  const docsFetch = options.docsFetch ?? ((input, init) => fetch(input, init))
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })

  app.use(requestId)
  app.use(timing({ total: true, crossOrigin: true }))
  app.use(requestTelemetry)
  app.use(
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Accept',
        'Authorization',
        'Mcp-Session-Id',
        'Mcp-Protocol-Version',
        'Mcp-Method',
        'Mcp-Name',
        'Last-Event-ID',
      ],
      exposeHeaders: [
        'Mcp-Session-Id',
        'X-Request-Id',
        'Retry-After',
        'RateLimit-Policy',
        'Server-Timing',
      ],
    })
  )

  app.get('/', (c) =>
    c.json({
      name: 'filecoin-api',
      version: VERSION,
      networks: NETWORK_NAMES,
      get: '/get/{cid}',
      openapi: '/openapi.json',
      docs: '/docs',
      mcp: '/mcp',
      serverCard: '/mcp/server-card',
    })
  )
  // Health queries every network's database, so it shares the API limit.
  app.get('/health', rateLimit('RATE_LIMIT_API'), async (c) => {
    const health = await checkHealth({
      env: c.env,
      dbFactory,
      dbStats: c.var.dbStats,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      requestId: c.var.requestId,
    })
    c.header('Cache-Control', 'no-store')
    return c.json(health, health.ok ? 200 : 503)
  })

  // The document only depends on the origin, so generate it once per isolate
  // and origin instead of on every request.
  let openapi: { origin: string; doc: unknown } | undefined
  app.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin
    if (openapi?.origin !== origin) {
      openapi = {
        origin,
        doc: app.getOpenAPI31Document(openApiConfig(origin)),
      }
    }
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(openapi.doc)
  })
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'filecoin-api' }))

  app.on(['GET', 'DELETE'], '/mcp', (c) => {
    c.header('Allow', 'POST')
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed: stateless server',
        },
        id: null,
      },
      405
    )
  })
  // The card changes only with a release or MCP_PUBLIC_URL, so clients can
  // cache it for an hour and revalidate it with its ETag.
  app.on('GET', SERVER_CARD_PATHS, rateLimit('RATE_LIMIT_API'), etag(), (c) => {
    const card = mcpServerCard(mcpUrl(new URL(c.req.url), c.env), VERSION)
    return c.body(JSON.stringify(card, null, 2), 200, {
      'Content-Type': SERVER_CARD_TYPE,
      'Cache-Control': 'public, max-age=3600',
    })
  })
  // Every Origin is valid. The spec asks servers to validate Origin against
  // DNS rebinding of local servers; this server is public and reads no
  // credentials, so a rebinding page gets nothing a direct request can't.
  // See "Security & Endpoint" in
  // https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
  app.post('/mcp', rateLimit('RATE_LIMIT_MCP'), async (c) => {
    const handles: McpHandle[] = []
    const factory = () => {
      const handle = buildMcpServer({
        env: c.env,
        dbFactory,
        dbStats: c.var.dbStats,
        version: VERSION,
        requestId: c.var.requestId,
        origin: new URL(c.req.url).origin,
        docsFetch,
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      })
      handles.push(handle)
      return handle.server
    }
    try {
      return await handleMcp(c.req.raw, factory)
    } finally {
      c.executionCtx.waitUntil(
        Promise.all(
          handles.map((h) => h.closeDbs().then(() => h.server.close()))
        )
      )
    }
  })

  app.route('/', networkRoutes(dbFactory))
  app.route('/', retrievalRoutes(dbFactory))

  app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404))

  app.onError((error, c) => {
    const { status, body, unexpected } = toErrorResponse(error)
    if (unexpected) {
      recordError(activeSpan(), error)
      log('error', {
        message: 'unhandled error',
        requestId: c.var.requestId,
        path: c.req.path,
        error: error.message,
        stack: error.stack,
      })
    }
    return c.json(body, status)
  })

  return app
}

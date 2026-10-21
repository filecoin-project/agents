import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/app.ts'
import { withMcpHosts } from '../src/mcp-host.ts'
import type { Bindings } from '../src/networks.ts'
import { testApp } from './helpers.ts'

const initialize = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  }),
}

/** Paths on an MCP host that serve the server card. */
const CARD_PATHS = [
  '/server-card',
  '/.well-known/mcp/server-card.json',
  '/.well-known/mcp-server-card',
]

/** The fields of a server card these tests read. */
interface Card {
  name: string
  version: string
  remotes: { type: string; url: string }[]
}

/**
 * Send a request through {@link withMcpHosts} with the test app.
 *
 * @param bindings - Bindings that override the ones in `wrangler.jsonc`.
 */
async function request(
  url: string,
  init?: RequestInit,
  bindings: Partial<Bindings> = {}
) {
  const { app } = testApp()
  const handler = withMcpHosts(app)
  const ctx = createExecutionContext()
  const testEnv = { ...env, ...bindings } as Bindings
  const res = await handler.fetch(new Request(url, init), testEnv, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

/** Fetch a server card and check the headers every card is sent with. */
async function card(url: string, bindings?: Partial<Bindings>) {
  const res = await request(url, undefined, bindings)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe(
    'application/mcp-server-card+json'
  )
  expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(res.headers.get('etag')).toBeTruthy()
  return (await res.json()) as Card
}

describe.each(['mcp.filecoin.io', 'mcp.filecoin.cloud'])(
  'mcp host %s',
  (host) => {
    it('serves the MCP endpoint at the root', async () => {
      const res = await request(`https://${host}/`, initialize)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        result: { serverInfo: { name: string } }
      }
      expect(body.result.serverInfo.name).toBe('io.filecoin/mcp')
      expect(res.headers.get('x-request-id')).toBeTruthy()
    })

    it('rejects GET at the root since the server is stateless', async () => {
      const res = await request(`https://${host}/`)
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    })

    it('answers the CORS preflight at the root', async () => {
      const res = await request(`https://${host}/`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'POST',
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })

    it.each(CARD_PATHS)(
      'serves the server card at %s, with the canonical URL',
      async (path) => {
        const body = await card(`https://${host}${path}`)
        expect(body.name).toBe('io.filecoin/mcp')
        expect(body.version).toBe(VERSION)
        expect(body.remotes).toEqual([
          expect.objectContaining({
            type: 'streamable-http',
            url: 'https://mcp.filecoin.io',
          }),
        ])
      }
    )

    it('advertises its own root when MCP_PUBLIC_URL is empty', async () => {
      const body = await card(`https://${host}/server-card`, {
        MCP_PUBLIC_URL: '',
      })
      expect(body.remotes[0]?.url).toBe(`https://${host}`)
    })

    it('revalidates the server card with its ETag', async () => {
      const first = await request(`https://${host}/server-card`)
      const etag = first.headers.get('etag') ?? ''
      const res = await request(`https://${host}/server-card`, {
        headers: { 'If-None-Match': etag },
      })
      expect(res.status).toBe(304)
    })

    it('serves nothing else', async () => {
      for (const path of [
        '/mcp',
        '/mcp/server-card',
        '/health',
        '/docs',
        '/calibration/providers',
      ]) {
        const res = await request(`https://${host}${path}`)
        expect(res.status).toBe(404)
        expect(await res.json()).toMatchObject({ error: { code: 'not_found' } })
      }
    })
  }
)

describe.each(['api.filecoin.io', 'api.filecoin.cloud'])(
  'api host %s',
  (host) => {
    it('is left unchanged', async () => {
      const root = await request(`https://${host}/`)
      expect(await root.json()).toMatchObject({
        mcp: '/mcp',
        serverCard: '/mcp/server-card',
      })
      const mcp = await request(`https://${host}/mcp`, initialize)
      expect(mcp.status).toBe(200)
    })

    it('serves the server card next to /mcp, with the canonical URL', async () => {
      for (const path of [
        '/mcp/server-card',
        '/.well-known/mcp/server-card.json',
        '/.well-known/mcp-server-card',
      ]) {
        const body = await card(`https://${host}${path}`)
        expect(body.remotes[0]?.url).toBe('https://mcp.filecoin.io')
      }
      expect((await request(`https://${host}/server-card`)).status).toBe(404)
    })

    it('advertises its own /mcp when MCP_PUBLIC_URL is empty', async () => {
      const body = await card(`https://${host}/mcp/server-card`, {
        MCP_PUBLIC_URL: '',
      })
      expect(body.remotes[0]?.url).toBe(`https://${host}/mcp`)
    })
  }
)

describe('preview', () => {
  it('advertises its own /mcp, since it has no MCP host', async () => {
    const body = await card(
      'https://pr-1-fil-api.filoz.workers.dev/mcp/server-card',
      { MCP_HOSTS: '', MCP_PUBLIC_URL: '' }
    )
    expect(body.remotes[0]?.url).toBe(
      'https://pr-1-fil-api.filoz.workers.dev/mcp'
    )
  })
})

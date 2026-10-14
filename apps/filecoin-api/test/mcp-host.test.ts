import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
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

/** Send a request through {@link withMcpHosts} with the test app. */
async function request(url: string, init?: RequestInit) {
  const { app } = testApp()
  const handler = withMcpHosts(app)
  const ctx = createExecutionContext()
  const res = await handler.fetch(new Request(url, init), env as Bindings, ctx)
  await waitOnExecutionContext(ctx)
  return res
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
      expect(body.result.serverInfo.name).toBe('filecoin-api')
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

    it('serves nothing else', async () => {
      for (const path of [
        '/mcp',
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
      expect(await root.json()).toMatchObject({ mcp: '/mcp' })
      const mcp = await request(`https://${host}/mcp`, initialize)
      expect(mcp.status).toBe(200)
    })
  }
)

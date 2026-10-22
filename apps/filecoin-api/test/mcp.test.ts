import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/app.ts'
import { MODERN_PROTOCOL_VERSION } from '../src/server-card.ts'
import { rows, testApp } from './helpers.ts'

function rpc(method: string, params: unknown = {}, id = 1) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }
}

/**
 * A 2026-07-28 request: the protocol version and client capabilities travel
 * in `_meta`, and the headers repeat the method, tool name and version.
 */
function modern(method: string, params: Record<string, unknown> = {}, id = 1) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(typeof params.name === 'string' && { 'Mcp-Name': params.name }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
        },
      },
    }),
  }
}

interface RpcResult<T> {
  result: T
}

interface RpcError {
  result?: unknown
  error: { code: number; message: string; data?: unknown }
}

describe('mcp', () => {
  it('initializes', async () => {
    const { request } = testApp()
    const res = await request(
      '/mcp',
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as RpcResult<{
      serverInfo: { name: string; title: string; version: string }
    }>
    expect(body.result.serverInfo).toEqual({
      name: 'io.filecoin/mcp',
      title: 'Filecoin',
      version: VERSION,
    })
  })

  it('reports the identity and protocol versions its server card declares', async () => {
    const { request } = testApp()
    const card = (await (await request('/mcp/server-card')).json()) as {
      name: string
      title: string
      version: string
      remotes: { supportedProtocolVersions: string[] }[]
    }
    const res = await request(
      '/mcp',
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      })
    )
    const body = (await res.json()) as RpcResult<{
      serverInfo: { name: string; title: string; version: string }
    }>
    expect(body.result.serverInfo).toEqual({
      name: card.name,
      title: card.title,
      version: card.version,
    })
    expect(card.remotes[0]?.supportedProtocolVersions).toContain('2025-06-18')
    expect(card.remotes[0]?.supportedProtocolVersions).toContain(
      MODERN_PROTOCOL_VERSION
    )
  })

  it('serves the modern revision the card declares', async () => {
    const { request } = testApp()
    const res = await request('/mcp', modern('server/discover'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as RpcResult<{
      supportedVersions: string[]
      _meta: Record<string, unknown>
    }>
    expect(body.result.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION])
    expect(body.result._meta['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'io.filecoin/mcp',
      title: 'Filecoin',
      version: VERSION,
    })
  })

  it('calls a tool over the modern revision', async () => {
    const { request, fake } = testApp(() => [rows.provider])
    const res = await request(
      '/mcp',
      modern('tools/call', {
        name: 'list_providers',
        arguments: { network: 'calibration', limit: 5 },
      })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = (await res.json()) as RpcResult<{
      resultType: string
      structuredContent: { data: { providerId: string }[] }
    }>
    expect(body.result.resultType).toBe('complete')
    expect(body.result.structuredContent.data[0]?.providerId).toBe('2')
    expect(fake.closed).toBe(1)
  })

  it('returns an unknown tool as a JSON-RPC error over the modern revision', async () => {
    const { request } = testApp()
    const body = (await (
      await request(
        '/mcp',
        modern('tools/call', { name: 'nope', arguments: {} })
      )
    ).json()) as RpcError
    expect(body.result).toBeUndefined()
    expect(body.error.code).toBe(-32602)
  })

  it('rejects an unsupported modern revision with the supported ones', async () => {
    const { request } = testApp()
    const init = modern('tools/list')
    const res = await request('/mcp', {
      ...init,
      headers: { ...init.headers, 'MCP-Protocol-Version': '2099-01-01' },
      body: init.body.replaceAll(MODERN_PROTOCOL_VERSION, '2099-01-01'),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as RpcError
    expect(body.error.data).toMatchObject({
      supported: [MODERN_PROTOCOL_VERSION],
    })
  })

  it('lists every tool, with a network argument on data tools', async () => {
    const { request } = testApp()
    const res = await request('/mcp', rpc('tools/list'))
    const body = (await res.json()) as RpcResult<{
      tools: {
        name: string
        title?: string
        annotations?: Record<string, boolean>
        inputSchema: { required?: string[] }
      }[]
    }>
    const names = body.result.tools.map((t) => t.name)
    expect(names.sort()).toEqual(
      [
        'get_status',
        'list_providers',
        'get_provider',
        'list_data_sets',
        'get_data_set',
        'list_data_set_pieces',
        'get_piece',
        'list_pieces',
        'list_rails',
        'get_rail',
        'list_rail_settlements',
        'list_session_keys',
        'list_session_key_events',
        'search_docs',
      ].sort()
    )
    for (const tool of body.result.tools) {
      expect(tool.title).toMatch(/^[A-Z][a-z]/)
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      })
      if (tool.name === 'search_docs') continue
      expect(tool.inputSchema.required).toContain('network')
    }
  })

  it('calls list_providers against the database', async () => {
    const { request, fake } = testApp(() => [rows.provider])
    const res = await request(
      '/mcp',
      rpc('tools/call', {
        name: 'list_providers',
        arguments: { network: 'calibration', approved: true, limit: 5 },
      })
    )
    const body = (await res.json()) as RpcResult<{
      structuredContent: { data: { providerId: string }[] }
    }>
    expect(body.result.structuredContent.data[0]?.providerId).toBe('2')
    expect(fake.queries[0]?.params).toEqual([true, 6])
    expect(fake.closed).toBe(1)
  })

  it('returns tool errors for unavailable networks and bad input', async () => {
    const { request } = testApp(undefined, { HYPERDRIVE_MAINNET: undefined })
    const mainnet = (await (
      await request(
        '/mcp',
        rpc('tools/call', {
          name: 'get_status',
          arguments: { network: 'mainnet' },
        })
      )
    ).json()) as RpcResult<{ isError: boolean; content: { text: string }[] }>
    expect(mainnet.result.isError).toBe(true)
    expect(mainnet.result.content[0]?.text).toContain('network_unavailable')

    const pieces = (await (
      await request(
        '/mcp',
        rpc('tools/call', {
          name: 'list_pieces',
          arguments: { network: 'calibration' },
        })
      )
    ).json()) as RpcResult<{ isError: boolean }>
    expect(pieces.result.isError).toBe(true)
  })

  it('hides unexpected tool errors', async () => {
    const { request } = testApp(() => {
      throw new Error('relation "secret" does not exist')
    })
    const body = (await (
      await request(
        '/mcp',
        rpc('tools/call', {
          name: 'list_providers',
          arguments: { network: 'calibration' },
        })
      )
    ).json()) as RpcResult<{ isError: boolean; content: { text: string }[] }>
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toBe(
      'internal_error: Internal server error'
    )
  })

  it('returns an unknown tool as a JSON-RPC error', async () => {
    const { request } = testApp()
    const body = (await (
      await request('/mcp', rpc('tools/call', { name: 'nope', arguments: {} }))
    ).json()) as RpcError
    expect(body.result).toBeUndefined()
    expect(body.error.code).toBe(-32602)
  })

  it('returns a tools/call without a name as a JSON-RPC error', async () => {
    const { request } = testApp()
    const body = (await (
      await request('/mcp', rpc('tools/call', { arguments: {} }))
    ).json()) as RpcError
    expect(body.result).toBeUndefined()
    expect(body.error.code).toBe(-32602)
  })

  it('rejects an unsupported protocol version with 400 and the supported versions', async () => {
    const { request } = testApp()
    const init = rpc('tools/list')
    const res = await request('/mcp', {
      ...init,
      headers: { ...init.headers, 'MCP-Protocol-Version': '1999-01-01' },
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as RpcError
    expect(body.error.message).toContain('2025-06-18')
  })

  it('keeps transport HTTP errors as JSON-RPC errors', async () => {
    const { request } = testApp()
    const res = await request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json, text/event-stream',
      },
      body: 'not json',
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
    })
  })

  it('rejects a client that does not accept both JSON and SSE', async () => {
    const { request } = testApp()
    const init = rpc('tools/list')
    const res = await request('/mcp', {
      ...init,
      headers: { ...init.headers, Accept: 'application/json' },
    })
    expect(res.status).toBe(406)
  })

  it('treats every Origin as valid', async () => {
    const { request } = testApp()
    const init = rpc('tools/list')
    const res = await request('/mcp', {
      ...init,
      headers: { ...init.headers, Origin: 'https://example.com' },
    })
    expect(res.status).toBe(200)
  })

  it('rejects GET since the server is stateless', async () => {
    const { request } = testApp()
    expect((await request('/mcp')).status).toBe(405)
  })
})

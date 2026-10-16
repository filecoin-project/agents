import { describe, expect, it } from 'vitest'
import {
  DOCS_MCP_URL,
  normalizeQuery,
  parseRpcResponse,
} from '../src/mcp/docs-search.ts'
import { testApp } from './helpers.ts'

/** A `tools/call` request for `search_docs`. */
function searchCall(query: string) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query } },
    }),
  }
}

/** Search result text as GitBook formats it. */
const RESULT_TEXT =
  'Title: Filecoin Pay\nLink: https://docs.filecoin.io/build/filecoin-pay\nContent: Payment rails.'

/** Fake GitBook MCP server that answers every call over SSE and records the requests. */
function fakeGitBook(respond?: () => Response) {
  const calls: { url: string; body: unknown }[] = []
  const docsFetch: typeof fetch = (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    })
    if (respond) return Promise.resolve(respond())
    const message = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: RESULT_TEXT }] },
    }
    return Promise.resolve(
      new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
  }
  return { calls, docsFetch }
}

interface ToolResult {
  result: { isError?: boolean; content: { type: string; text: string }[] }
}

describe('search_docs', () => {
  it('forwards the query to GitBook and returns its content', async () => {
    const gitbook = fakeGitBook()
    const { request } = testApp(undefined, {}, gitbook)
    const res = await request('/mcp', searchCall('  Payment   RAILS forward '))
    const body = (await res.json()) as ToolResult
    expect(body.result.isError).toBeUndefined()
    expect(body.result.content).toEqual([{ type: 'text', text: RESULT_TEXT }])
    expect(gitbook.calls).toEqual([
      {
        url: DOCS_MCP_URL,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'searchDocumentation',
            arguments: { query: 'payment rails forward' },
          },
        },
      },
    ])
  })

  it('answers equivalent queries from the cache', async () => {
    const gitbook = fakeGitBook()
    const { request } = testApp(undefined, {}, gitbook)
    await request('/mcp', searchCall('cached docs query'))
    const res = await request('/mcp', searchCall('Cached  DOCS query'))
    const body = (await res.json()) as ToolResult
    expect(body.result.content[0]?.text).toBe(RESULT_TEXT)
    expect(gitbook.calls).toHaveLength(1)
  })

  it('returns a tool error when GitBook fails, without caching it', async () => {
    const failing = fakeGitBook(() => new Response('oops', { status: 500 }))
    const { request } = testApp(undefined, {}, failing)
    const body = (await (
      await request('/mcp', searchCall('failing docs query'))
    ).json()) as ToolResult
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toBe(
      'docs_unavailable: Filecoin docs search is unavailable: GitBook returned 500'
    )

    const gitbook = fakeGitBook()
    const retry = testApp(undefined, {}, gitbook)
    await retry.request('/mcp', searchCall('failing docs query'))
    expect(gitbook.calls).toHaveLength(1)
  })

  it('rejects an empty query', async () => {
    const gitbook = fakeGitBook()
    const { request } = testApp(undefined, {}, gitbook)
    const body = (await (
      await request('/mcp', searchCall('   '))
    ).json()) as ToolResult
    expect(body.result.isError).toBe(true)
    expect(gitbook.calls).toHaveLength(0)
  })
})

describe('parseRpcResponse', () => {
  it('reads plain JSON and the matching SSE event', () => {
    expect(
      parseRpcResponse('{"id":1,"result":{}}', 'application/json')
    ).toEqual({ id: 1, result: {} })
    const sse =
      'event: message\ndata: {"method":"notifications/progress"}\n\nevent: message\ndata: {"id":1,"result":{"content":[]}}\n\n'
    expect(parseRpcResponse(sse, 'text/event-stream')).toEqual({
      id: 1,
      result: { content: [] },
    })
  })
})

describe('normalizeQuery', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(normalizeQuery('  Filecoin\n Pay  ')).toBe('filecoin pay')
  })
})

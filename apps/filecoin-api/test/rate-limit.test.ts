import { describe, expect, it } from 'vitest'
import { fakeLimiter, rows, testApp } from './helpers.ts'

describe('rate limits', () => {
  it('returns 429 with Retry-After when the API limiter rejects', async () => {
    const { request, fake } = testApp(() => [rows.provider], {
      RATE_LIMIT_API: fakeLimiter(false),
    })
    const res = await request('/calibration/providers')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('ratelimit-policy')).toBe('"api";q=120;w=60')
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } })
    expect(fake.queries).toHaveLength(0)
  })

  it('limits MCP separately', async () => {
    const { request } = testApp(undefined, {
      RATE_LIMIT_MCP: fakeLimiter(false),
    })
    const res = await request('/mcp', { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    expect(res.headers.get('ratelimit-policy')).toBe('"mcp";q=60;w=60')
  })

  it('sends the policy on allowed REST, health and retrieval requests', async () => {
    const { request } = testApp((text) =>
      text.includes('chain_id') ? [rows.checkpoint] : [rows.provider]
    )
    for (const path of [
      '/calibration/providers',
      '/health',
      '/get/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi?browser=true',
    ]) {
      const res = await request(path, { redirect: 'manual' })
      expect(res.status, path).not.toBe(429)
      expect(res.headers.get('ratelimit-policy'), path).toBe('"api";q=120;w=60')
    }
  })

  it('sends the MCP policy on allowed MCP requests', async () => {
    const { request } = testApp()
    const res = await request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('ratelimit-policy')).toBe('"mcp";q=60;w=60')
  })

  it('exposes the policy to browsers', async () => {
    const { request } = testApp(() => [rows.provider])
    const res = await request('/calibration/providers', {
      headers: { Origin: 'https://example.com' },
    })
    expect(res.headers.get('access-control-expose-headers')).toContain(
      'RateLimit-Policy'
    )
  })

  it('limits health, which queries every database', async () => {
    const { request, fake } = testApp(() => [rows.checkpoint], {
      RATE_LIMIT_API: fakeLimiter(false),
    })
    expect((await request('/health')).status).toBe(429)
    expect(fake.queries).toHaveLength(0)
  })

  it('does not limit docs or the OpenAPI document', async () => {
    const { request } = testApp(undefined, {
      RATE_LIMIT_API: fakeLimiter(false),
      RATE_LIMIT_MCP: fakeLimiter(false),
    })
    for (const path of ['/openapi.json', '/docs']) {
      const res = await request(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('ratelimit-policy')).toBeNull()
    }
  })
})

import { describe, expect, it } from 'vitest'
import type { Row } from '../src/db.ts'
import { fakeLimiter, rows, testApp } from './helpers.ts'

/** One request per data route, under `/v1`, with a row its query returns. */
const DATA_ROUTES: [string, Row][] = [
  ['/v1/calibration/status', rows.checkpoint],
  ['/v1/calibration/providers/2', rows.provider],
  [
    '/v1/calibration/data-sets?owner=0x480c51fe9fc90e01fa742c51300cc29e151a71cd',
    rows.dataSet,
  ],
  ['/v1/calibration/data-sets/14015', rows.dataSet],
  ['/v1/calibration/data-sets/1/pieces?removed=false', rows.piece],
  ['/v1/calibration/data-sets/1/pieces/0', rows.piece],
  [
    `/v1/calibration/pieces?cid=${rows.piece.cid}`,
    { ...rows.piece, ...rows.dataSet, data_set_id: '1' },
  ],
  ['/v1/calibration/rails?state=active', rows.rail],
  ['/v1/calibration/rails/12818', rows.rail],
  ['/v1/calibration/rails/12818/settlements', rows.settlement],
  ['/v1/calibration/session-keys?active=true', rows.sessionKey],
  ['/v1/calibration/session-keys/history', rows.sessionKeyEvent],
]

describe('rest routes', () => {
  it('serves the index without the database', async () => {
    const { request, fake } = testApp()
    expect((await request('/')).status).toBe(200)
    expect(fake.queries).toHaveLength(0)
  })

  it('links the index to the OpenAPI document and the docs', async () => {
    const { request } = testApp()
    const link = (await request('/')).headers.get('link')
    expect(link).toContain('</openapi.json>; rel="service-desc"')
    expect(link).toContain('</docs>; rel="service-doc"')
  })

  it('names the versioned data route prefix in the index', async () => {
    const { request } = testApp()
    const body = (await (await request('/')).json()) as { api: string }
    expect(body.api).toBe('/v1/{network}')
  })

  it('lists providers with pagination and cache headers', async () => {
    const { request, fake } = testApp(() => [
      rows.provider,
      { ...rows.provider, provider_id: '1' },
    ])
    const res = await request('/v1/calibration/providers?limit=1&approved=true')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBeNull()
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('server-timing')).toContain('db;dur=')
    const body = (await res.json()) as {
      data: { providerId: string }[]
      nextCursor: string
    }
    expect(body.data).toEqual([
      expect.objectContaining({ providerId: '2', approved: true }),
    ])
    expect(fake.queries[0]?.params).toEqual([true, 2])
    expect(fake.closed).toBe(1)

    await request(`/v1/calibration/providers?limit=1&cursor=${body.nextCursor}`)
    expect(fake.queries[1]?.text).toContain('provider_id < $1::bigint')
    expect(fake.queries[1]?.params).toEqual(['2', 2])
  })

  it.each(DATA_ROUTES)('GET %s', async (path, row) => {
    const { request } = testApp(() => [row])
    const res = await request(path)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: unknown }
    expect(data).toBeTruthy()
  })

  // Released CLIs, API clients and plugins call the paths from before /v1.
  it.each(DATA_ROUTES)(
    'serves %s at its unversioned alias',
    async (path, row) => {
      const { request, fake } = testApp(() => [row])
      const alias = await request(path.replace(/^\/v1/, ''))
      const versioned = await request(path)
      expect(alias.status).toBe(200)
      expect(alias.headers.get('ratelimit-policy')).toBe(
        versioned.headers.get('ratelimit-policy')
      )
      expect(await alias.json()).toEqual(await versioned.json())
      expect(fake.queries[0]).toEqual(fake.queries[1])
      expect(fake.closed).toBe(2)
    }
  )

  it('returns 404 unknown_network for an unknown network alias', async () => {
    const { request } = testApp()
    const res = await request('/filecoin/providers')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: { code: 'unknown_network' },
    })
  })

  it('maps rails to the API shape', async () => {
    const { request } = testApp(() => [rows.rail])
    const { data } = (await (
      await request('/v1/calibration/rails/12818')
    ).json()) as {
      data: Record<string, unknown>
    }
    expect(data).toMatchObject({
      railId: '12818',
      state: 'active',
      paymentRate: '694444444444',
      totalSettledAmount: '466167361110812764',
      createdAt: 1770396420,
    })
  })

  it('maps piece lookups with owner and provider', async () => {
    const { request, fake } = testApp(() => [
      { ...rows.piece, payer: rows.dataSet.payer, provider_id: '2' },
    ])
    const res = await request(
      '/v1/calibration/pieces?owner=0x480C51FE9FC90E01FA742C51300CC29E151A71CD'
    )
    const { data } = (await res.json()) as { data: Record<string, unknown>[] }
    expect(data[0]).toMatchObject({
      owner: rows.dataSet.payer,
      providerId: '2',
    })
    // The Address schema lowercases input before it reaches the query.
    expect(fake.queries[0]?.params[0]).toBe(rows.dataSet.payer)
  })

  it('queries pieces by the canonical PieceCID v2 string', async () => {
    const { request, fake } = testApp(() => [])
    const hex =
      '0x015591202586bdb70313ae7192454f8e556bf57b22b63b61a6313924334ed80f257e47291a377d351b3e'
    const res = await request(`/v1/calibration/pieces?cid=${hex}`)
    expect(res.status).toBe(200)
    expect(fake.queries[0]?.params[0]).toBe(rows.piece.cid)
  })

  it('queries pieces by the base32 CIDv1 of an IPFS root CID', async () => {
    const { request, fake } = testApp(() => [])
    const res = await request(
      '/v1/calibration/pieces?ipfs_cid=QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
    )
    expect(res.status).toBe(200)
    expect(fake.queries[0]?.text).toContain('p.ipfs_root_cid = $1')
    expect(fake.queries[0]?.params[0]).toBe(
      'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
    )
  })

  it('names legacy v1 PieceCIDs in the error', async () => {
    const { request } = testApp()
    const res = await request(
      '/v1/calibration/pieces?cid=baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq'
    )
    const { error } = (await res.json()) as { error: { message: string } }
    expect(error.message).toContain(
      'Legacy v1 PieceCIDs are not supported, use v2'
    )
  })

  it('lowercases checksummed provider addresses', async () => {
    const { request } = testApp(() => [
      {
        ...rows.provider,
        provider_address: '0x658e67B13F814fa48af1cd0b5695B158E596822E',
      },
    ])
    const { data } = (await (
      await request('/v1/mainnet/providers/37')
    ).json()) as { data: { address: string } }
    expect(data.address).toBe('0x658e67b13f814fa48af1cd0b5695b158e596822e')
  })

  it('returns 404 for missing resources', async () => {
    const { request } = testApp(() => [])
    const res = await request('/v1/calibration/rails/999')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Rail 999 not found' },
    })
  })

  it.each([
    ['/v1/calibration/pieces', 'invalid_request'],
    ['/v1/calibration/pieces?cid=notacid', 'invalid_request'],
    [
      '/v1/calibration/pieces?cid=baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq',
      'invalid_request',
    ],
    [
      '/v1/calibration/pieces?cid=bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
      'invalid_request',
    ],
    ['/v1/calibration/pieces?ipfs_cid=notacid', 'invalid_request'],
    [`/v1/calibration/pieces?ipfs_cid=${rows.piece.cid}`, 'invalid_request'],
    ['/v1/calibration/data-sets?owner=nope', 'invalid_request'],
    ['/v1/calibration/providers?limit=500', 'invalid_request'],
    ['/v1/calibration/providers/abc', 'invalid_request'],
    ['/v1/calibration/data-sets/99999999999999999999', 'invalid_request'],
    ['/v1/calibration/rails/99999999999999999999', 'invalid_request'],
    [`/v1/calibration/data-sets?cursor=${btoa('["abc"]')}`, 'invalid_cursor'],
    ['/v1/calibration/rails?state=open', 'invalid_request'],
    ['/v1/calibration/providers?cursor=zzz', 'invalid_cursor'],
  ])('returns 400 for %s', async (path, code) => {
    const { request, fake } = testApp()
    const res = await request(path)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      code
    )
    expect(fake.queries).toHaveLength(0)
  })

  it('returns 404 for unknown networks and routes', async () => {
    const { request } = testApp()
    const network = await request('/v1/filecoin/providers')
    expect(network.status).toBe(404)
    expect(await network.json()).toMatchObject({
      error: { code: 'unknown_network' },
    })
    const route = await request('/nope')
    expect(route.status).toBe(404)
    expect(await route.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('reports unknown networks before other validation errors', async () => {
    const { request } = testApp()
    const res = await request('/v1/filecoin/data-sets?owner=nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: { code: 'unknown_network' },
    })
  })

  it.each(['/sitemap.xml', '/filecoin/nope', '/wp-admin/install.php'])(
    'skips network middleware and rate limits for %s',
    async (path) => {
      const { request, fake } = testApp(undefined, {
        RATE_LIMIT_API: fakeLimiter(false),
      })
      const res = await request(path)
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: { code: 'not_found' } })
      expect(fake.closed).toBe(0)
    }
  )

  it('uses the Cloudflare Ray ID as the request id', async () => {
    const { request } = testApp(() => [rows.provider])
    const res = await request('/v1/calibration/providers', {
      headers: { 'cf-ray': 'a44c2706e8c0b23b', 'x-request-id': 'spoofed' },
    })
    expect(res.headers.get('x-request-id')).toBe('a44c2706e8c0b23b')
  })

  it('ignores client request ids without a Ray ID', async () => {
    const { request } = testApp()
    const res = await request('/', { headers: { 'x-request-id': 'spoofed' } })
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns 503 for a network without a database binding', async () => {
    const { request, fake } = testApp(undefined, {
      HYPERDRIVE_MAINNET: undefined,
    })
    const res = await request('/v1/mainnet/providers')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: { code: 'network_unavailable' },
    })
    expect(fake.queries).toHaveLength(0)
  })

  it('serves mainnet once its binding exists', async () => {
    const { request } = testApp(() => [rows.provider], {
      HYPERDRIVE_MAINNET: { connectionString: 'postgresql://x' } as Hyperdrive,
    })
    expect((await request('/v1/mainnet/providers')).status).toBe(200)
  })

  it('hides internal errors', async () => {
    const { request } = testApp(() => {
      throw new Error('relation "secret" does not exist')
    })
    const res = await request('/v1/calibration/providers')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('secret')
    expect(JSON.parse(text)).toMatchObject({
      error: { code: 'internal_error' },
    })
  })
})

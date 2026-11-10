import { calculate } from '@filoz/synapse-core/piece'
import { CID } from 'multiformats/cid'
import { create } from 'multiformats/hashes/digest'
import { beforeEach, describe, expect, it } from 'vitest'
import { httpsOrigin, IPNI_MAX_PROVIDERS } from '../src/ipni.ts'
import { NETWORK_NAMES } from '../src/networks.ts'
import {
  INBROWSER_URL,
  PROVIDER_REDIRECT_CACHE_CONTROL,
  providersCacheKey,
} from '../src/routes/retrieval.ts'
import { fakeLimiter, rows, testApp } from './helpers.ts'

const SERVICE_URL = rows.provider.service_url
const providerRow = {
  provider_id: '2',
  service_url: SERVICE_URL,
  ipfs_root_cid: null,
}
const ROOT_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

let seed = 0

/**
 * A PieceCID no other test uses, so `caches.default` entries from earlier
 * tests in this file do not leak in.
 */
async function uniquePieceCid() {
  return (await calculate(new Uint8Array(127).fill(++seed))).toString()
}

/** Whether a query is the active-provider list rather than a piece lookup. */
function isProviderList(text: string) {
  return text.includes('order by endorsed desc')
}

/** A row of the active-provider list. */
function activeRow(
  providerId: string,
  serviceUrl: string,
  flags: { endorsed?: boolean; approved?: boolean } = {}
) {
  return {
    provider_id: providerId,
    service_url: serviceUrl,
    endorsed: flags.endorsed ?? false,
    approved: flags.approved ?? false,
  }
}

/** A delegated routing peer record, as cid.contact sends it. */
function peer(
  id: string,
  addrs: string[],
  protocols = ['transport-ipfs-gateway-http']
) {
  return { Schema: 'peer', ID: id, Addrs: addrs, Protocols: protocols }
}

/**
 * Fake IPNI that answers every lookup with `records` as NDJSON, or with
 * `respond`, and records each request.
 */
function fakeIpni(
  records: object[] = [],
  respond?: () => Response | Promise<Response>
) {
  const calls: { url: string; accept: string | null; signal?: AbortSignal }[] =
    []
  const ipniFetch: typeof fetch = (input, init) => {
    calls.push({
      url: String(input),
      accept: new Headers(init?.headers).get('accept'),
      signal: init?.signal ?? undefined,
    })
    if (respond) return Promise.resolve(respond())
    if (records.length === 0) {
      return Promise.resolve(new Response('', { status: 404 }))
    }
    const body = records.map((r) => `${JSON.stringify(r)}\n`).join('')
    return Promise.resolve(
      new Response(body, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      })
    )
  }
  return { ipniFetch, calls }
}

/** A raw-codec IPFS CID no other test uses. */
function uniqueIpfsCid() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return CID.createV1(0x55, create(0x12, bytes)).toString()
}

describe('GET /get/{cid}', () => {
  // The provider list is cached per network; start every test without it.
  beforeEach(async () => {
    for (const network of NETWORK_NAMES) {
      await caches.default.delete(
        providersCacheKey('http://localhost', network)
      )
    }
  })

  it('redirects a PieceCID to a mainnet provider and caches it', async () => {
    const cid = await uniquePieceCid()
    const { request, fake } = testApp(() => [providerRow])
    const res = await request(`/get/${cid}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
    expect(res.headers.get('x-cache')).toBe('miss')
    expect(res.headers.get('cache-control')).toBe(
      PROVIDER_REDIRECT_CACHE_CONTROL
    )
    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0]?.text).toContain('p.cid = $1')
    expect(fake.queries[0]?.params).toEqual([cid])
    expect(fake.closed).toBe(1)

    const again = await request(`/get/${cid}`)
    expect(again.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
    expect(again.headers.get('x-cache')).toBe('hit')
    expect(fake.queries).toHaveLength(1)
  })

  it('caches providers per network', async () => {
    const cid = await uniquePieceCid()
    const { request, fake } = testApp(() => [providerRow])
    await request(`/get/${cid}?network=calibration`)
    const res = await request(`/get/${cid}`)
    expect(res.headers.get('x-cache')).toBe('miss')
    expect(fake.queries).toHaveLength(2)
  })

  it('sends PieceCIDs without an IPFS root to the provider with browser=true', async () => {
    const cid = await uniquePieceCid()
    const { request } = testApp(() => [providerRow])
    const res = await request(`/get/${cid}?browser=true`)
    expect(res.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
  })

  it('opens PieceCIDs with an IPFS root in inbrowser.link with browser=true', async () => {
    const cid = await uniquePieceCid()
    const { request, fake } = testApp(() => [
      { ...providerRow, ipfs_root_cid: ROOT_CID },
    ])
    const res = await request(`/get/${cid}?browser=true&filename=a.txt`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${INBROWSER_URL}/ipfs/${ROOT_CID}?filename=a.txt`
    )
    expect(res.headers.get('x-cache')).toBe('miss')
    expect(fake.queries[0]?.text).toContain(
      'case when d.with_ipfs_indexing then p.ipfs_root_cid end'
    )

    // The cached entry keeps the root, and plain requests still get bytes.
    const cached = await request(`/get/${cid}?browser=true`)
    expect(cached.headers.get('location')).toBe(
      `${INBROWSER_URL}/ipfs/${ROOT_CID}`
    )
    expect(cached.headers.get('x-cache')).toBe('hit')
    const raw = await request(`/get/${cid}`)
    expect(raw.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
    expect(fake.queries).toHaveLength(1)
  })

  it.each(['nope', rows.piece.cid])(
    'ignores an ipfsRootCID of %s that is not an IPFS CID',
    async (root) => {
      const cid = await uniquePieceCid()
      const { request } = testApp(() => [
        { ...providerRow, ipfs_root_cid: root },
      ])
      const res = await request(`/get/${cid}?browser=true`)
      expect(res.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
    }
  )

  it('redirects IPFS root CIDs to the provider gateway', async () => {
    const cid = uniqueIpfsCid()
    const { request, fake } = testApp(() => [providerRow])
    const res = await request(
      `/get/${cid}?network=calibration&browser=false&format=car`
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${SERVICE_URL}/ipfs/${cid}?format=car`
    )
    expect(fake.queries[0]?.text).toContain(
      'p.ipfs_root_cid = $1 and d.with_ipfs_indexing'
    )
    expect(fake.queries[0]?.params).toEqual([cid])
  })

  it('looks up CIDv0 roots as base32 CIDv1, as the indexer stores them', async () => {
    const v1 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
    const { request, fake } = testApp((_text, params) =>
      params.includes(v1) ? [providerRow] : []
    )
    const res = await request(
      '/get/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG?network=calibration'
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${SERVICE_URL}/ipfs/${v1}`)
    expect(fake.queries[0]?.params).toEqual([v1])
  })

  it('redirects IPFS CIDs to inbrowser.link with browser=true', async () => {
    const { request, fake } = testApp()
    const res = await request(
      '/get/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG?browser=true&filename=a.txt'
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${INBROWSER_URL}/ipfs/bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34?filename=a.txt`
    )
    expect(res.headers.get('x-cache')).toBe('none')
    expect(fake.queries).toHaveLength(0)
  })

  it('keeps the service URL path and avoids double slashes', async () => {
    const cid = await uniquePieceCid()
    const { request } = testApp(() => [
      { provider_id: '3', service_url: 'https://sp.example/curio/' },
    ])
    const res = await request(`/get/${cid}`)
    expect(res.headers.get('location')).toBe(
      `https://sp.example/curio/piece/${cid}`
    )
  })

  it('returns 404 without caching when no provider serves the CID', async () => {
    const cid = await uniquePieceCid()
    const { request, fake } = testApp(() => [])
    const res = await request(`/get/${cid}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: `Piece ${cid} not found` },
    })
    await request(`/get/${cid}`)
    expect(fake.queries).toHaveLength(2)
  })

  describe('provider hint', () => {
    const HINT_URL = 'https://hint.example'

    /** No indexed copy; the list of active providers has the hinted one. */
    function hintOnly(text: string) {
      return isProviderList(text) ? [activeRow('9', HINT_URL)] : []
    }

    it('redirects to the hinted provider without asking IPNI or caching it', async () => {
      const cid = await uniquePieceCid()
      const ipni = fakeIpni()
      const { request, fake } = testApp(hintOnly, {}, ipni)
      const res = await request(
        `/get/${cid}?network=calibration&browser=true&provider=9&filename=a.bin`
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(
        `${HINT_URL}/piece/${cid}?filename=a.bin`
      )
      expect(res.headers.get('x-source')).toBe('hint')
      expect(res.headers.get('cache-control')).toBe(
        PROVIDER_REDIRECT_CACHE_CONTROL
      )
      expect(ipni.calls).toHaveLength(0)
      expect(fake.queries.filter((q) => isProviderList(q.text))).toHaveLength(1)

      // The piece lookup runs again, and the provider list is cached.
      await request(`/get/${cid}?network=calibration&provider=9`)
      expect(fake.queries).toHaveLength(3)
      expect(ipni.calls).toHaveLength(0)
    })

    it('prefers an indexed copy over the hint', async () => {
      const cid = await uniquePieceCid()
      const ipni = fakeIpni()
      const { request, fake } = testApp(() => [providerRow], {}, ipni)
      const res = await request(`/get/${cid}?provider=9`)
      expect(res.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
      expect(res.headers.get('x-source')).toBe('index')
      expect(fake.queries).toHaveLength(1)
      expect(ipni.calls).toHaveLength(0)
    })

    it('asks IPNI when the hinted provider is unknown or inactive', async () => {
      const cid = await uniquePieceCid()
      const ipni = fakeIpni([
        peer(
          'p1',
          ['/dns/other.example/tcp/443/https'],
          ['transport-filecoin-piece-http']
        ),
      ])
      const { request } = testApp(
        (text) => (isProviderList(text) ? [activeRow('3', HINT_URL)] : []),
        {},
        ipni
      )
      const res = await request(`/get/${cid}?provider=9`)
      expect(res.headers.get('location')).toBe(
        `https://other.example/piece/${cid}`
      )
      expect(res.headers.get('x-source')).toBe('ipni')
      expect(ipni.calls).toHaveLength(1)
    })

    it('returns 404 when neither the hint nor IPNI knows the piece', async () => {
      const cid = await uniquePieceCid()
      const { request } = testApp(() => [])
      const res = await request(`/get/${cid}?provider=9`)
      expect(res.status).toBe(404)
    })
  })

  describe('IPNI', () => {
    it('redirects an IPFS CID the indexer lacks to a registry provider from IPNI', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([
        peer('p1', ['/dns/calib2.ezpdpz.net/tcp/443/https']),
      ])
      const { request, fake } = testApp(
        (text) =>
          isProviderList(text)
            ? [activeRow('2', 'https://calib2.ezpdpz.net/curio')]
            : [],
        {},
        ipni
      )
      const res = await request(`/get/${cid}?format=car`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(
        `https://calib2.ezpdpz.net/curio/ipfs/${cid}?format=car`
      )
      expect(res.headers.get('x-source')).toBe('ipni')
      expect(res.headers.get('x-cache')).toBe('miss')
      expect(ipni.calls[0]?.url).toBe(
        `https://cid.contact/routing/v1/providers/${cid}`
      )
      expect(ipni.calls[0]?.accept).toBe('application/x-ndjson')

      const again = await request(`/get/${cid}`)
      expect(again.headers.get('x-cache')).toBe('hit')
      expect(again.headers.get('x-source')).toBe('ipni')
      expect(ipni.calls).toHaveLength(1)
      expect(fake.queries).toHaveLength(2)
    })

    it('redirects to a provider outside the registry', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([peer('p1', ['/dns4/gw.example/tcp/8443/https'])])
      const { request } = testApp(() => [], {}, ipni)
      const res = await request(`/get/${cid}`)
      expect(res.headers.get('location')).toBe(
        `https://gw.example:8443/ipfs/${cid}`
      )
    })

    it('ranks endorsed, then approved registry providers ahead of IPNI order', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([
        peer('p1', ['/dns/outside.example/tcp/443/https']),
        peer('p2', ['/dns/approved.example/tcp/443/https']),
        peer('p3', ['/dns/endorsed.example/tcp/443/https']),
      ])
      const { request } = testApp(
        (text) =>
          isProviderList(text)
            ? [
                activeRow('5', 'https://endorsed.example', { endorsed: true }),
                activeRow('4', 'https://approved.example', { approved: true }),
              ]
            : [],
        {},
        ipni
      )
      const res = await request(`/get/${cid}`)
      expect(res.headers.get('location')).toBe(
        `https://endorsed.example/ipfs/${cid}`
      )
    })

    it('skips providers without the transport or an https DNS address', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([
        peer('p1', ['/ip4/1.2.3.4/tcp/443/https']),
        peer('p2', ['/dns/plain.example/tcp/80/http']),
        peer(
          'p3',
          ['/dns/bitswap.example/tcp/443/https'],
          ['transport-bitswap']
        ),
        peer('p4', ['/dns/ok.example/tcp/443/tls/http']),
      ])
      const { request } = testApp(() => [], {}, ipni)
      const res = await request(`/get/${cid}`)
      expect(res.headers.get('location')).toBe(`https://ok.example/ipfs/${cid}`)
    })

    it('looks up PieceCIDs by the piece transport', async () => {
      const cid = await uniquePieceCid()
      const ipni = fakeIpni([
        peer('p1', ['/dns/gateway.example/tcp/443/https']),
        peer(
          'p2',
          ['/dns/piece.example/tcp/443/https'],
          ['transport-filecoin-piece-http']
        ),
      ])
      const { request } = testApp(() => [], {}, ipni)
      const res = await request(`/get/${cid}`)
      expect(res.headers.get('location')).toBe(
        `https://piece.example/piece/${cid}`
      )
    })

    it(`reads at most ${IPNI_MAX_PROVIDERS} records`, async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([
        ...Array.from({ length: IPNI_MAX_PROVIDERS }, (_, i) =>
          peer(`p${i}`, [], [])
        ),
        peer('late', ['/dns/late.example/tcp/443/https']),
      ])
      const { request } = testApp(() => [], {}, ipni)
      const res = await request(`/get/${cid}`)
      expect(res.status).toBe(404)
    })

    it('prefers the indexer and aborts the IPNI request', async () => {
      const cid = await uniquePieceCid()
      const ipni = fakeIpni([
        peer(
          'p1',
          ['/dns/fast.example/tcp/443/https'],
          ['transport-filecoin-piece-http']
        ),
      ])
      const slowDb = () =>
        new Promise<(typeof providerRow)[]>((resolve) =>
          setTimeout(() => resolve([providerRow]), 20)
        )
      const { request, fake } = testApp(slowDb, {}, ipni)
      const res = await request(`/get/${cid}`)
      expect(res.headers.get('location')).toBe(`${SERVICE_URL}/piece/${cid}`)
      expect(res.headers.get('x-source')).toBe('index')
      expect(ipni.calls[0]?.signal?.aborted).toBe(true)
      expect(fake.queries).toHaveLength(1)
    })

    it('returns 502 without caching when IPNI fails', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([], () => new Response('down', { status: 500 }))
      const { request } = testApp(() => [], {}, ipni)
      const res = await request(`/get/${cid}`)
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({
        error: {
          code: 'ipni_unavailable',
          message: 'IPNI lookup failed: IPNI returned 500',
        },
      })
      await request(`/get/${cid}`)
      expect(ipni.calls).toHaveLength(2)
    })

    it('returns 502 when the IPNI request throws', async () => {
      const cid = uniqueIpfsCid()
      const ipniFetch: typeof fetch = () => Promise.reject(new Error('boom'))
      const { request } = testApp(() => [], {}, { ipniFetch })
      const res = await request(`/get/${cid}`)
      expect(res.status).toBe(502)
    })

    it('uses IPNI_URL', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni()
      const { request } = testApp(
        () => [],
        { IPNI_URL: 'https://ipni.example/base' },
        ipni
      )
      await request(`/get/${cid}`)
      expect(ipni.calls[0]?.url).toBe(
        `https://ipni.example/base/routing/v1/providers/${cid}`
      )
    })

    it('resolves through IPNI for a network without a database binding', async () => {
      const cid = uniqueIpfsCid()
      const ipni = fakeIpni([peer('p1', ['/dns/gw.example/tcp/443/https'])])
      const { request, fake } = testApp(
        () => [],
        { HYPERDRIVE_MAINNET: undefined },
        ipni
      )
      const res = await request(`/get/${cid}`)
      expect(res.headers.get('location')).toBe(`https://gw.example/ipfs/${cid}`)
      expect(fake.queries).toHaveLength(0)
    })
  })

  describe('httpsOrigin', () => {
    it.each([
      ['/dns/sp.example/tcp/443/https', 'https://sp.example'],
      ['/dns6/sp.example/tcp/8443/https', 'https://sp.example:8443'],
      ['/dns/sp.example/tcp/443/tls/sni/sp.example/http', 'https://sp.example'],
      ['/dns/sp.example/tcp/80/http', undefined],
      ['/ip4/1.2.3.4/tcp/443/https', undefined],
      ['/dns/sp.example/tcp/443/https/p2p/12D3', undefined],
    ])('maps %s to %s', (addr, origin) => {
      expect(httpsOrigin(addr)).toBe(origin)
    })
  })

  it.each([
    `/get/${rows.piece.cid}?provider=sp9`,
    '/get/nope',
    '/get/baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq',
    `/get/${rows.piece.cid}?network=filecoin`,
    `/get/${rows.piece.cid}?browser=yes`,
  ])('returns 400 for %s', async (path) => {
    const { request, fake } = testApp()
    const res = await request(path)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: 'invalid_request' },
    })
    expect(fake.queries).toHaveLength(0)
  })

  it('is rate limited', async () => {
    const { request } = testApp(undefined, {
      RATE_LIMIT_API: fakeLimiter(false),
    })
    const res = await request(`/get/${rows.piece.cid}`)
    expect(res.status).toBe(429)
  })
})

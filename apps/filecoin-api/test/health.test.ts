import { describe, expect, it } from 'vitest'
import { rows, testApp } from './helpers.ts'

const checkpoint = rows.checkpoint

describe('health', () => {
  it('reports the latest block per network', async () => {
    const { request, fake } = testApp(() => [checkpoint])
    const res = await request('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      ok: true,
      networks: {
        calibration: {
          status: 'ok',
          chainId: 314159,
          blockNumber: 4121900,
          indexers: { ozone: 4121900 },
        },
        mainnet: {
          status: 'ok',
          chainId: 314,
          blockNumber: 4121900,
          indexers: { ozone: 4121900 },
        },
      },
    })
    expect(fake.closed).toBe(2)
  })

  it('marks unconfigured networks unavailable without failing', async () => {
    const { request } = testApp(() => [checkpoint], {
      HYPERDRIVE_MAINNET: undefined,
    })
    const res = await request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      networks: { mainnet: { status: 'unavailable' } },
    })
  })

  it('returns 503 when a database fails', async () => {
    const { request, fake } = testApp(() => {
      throw new Error('connection refused')
    })
    const res = await request('/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      ok: false,
      networks: {
        calibration: { status: 'error' },
        mainnet: { status: 'error' },
      },
    })
    expect(fake.closed).toBe(2)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError, createApiClient, unwrap } from '@filecoin-project/api-client'

/** Client whose `fetch` answers every request with `response`. */
function clientReturning(response: Response) {
  const requests: Request[] = []
  const api = createApiClient({
    fetch: (request: Request) => {
      requests.push(request)
      return Promise.resolve(response)
    },
  })
  return { api, requests }
}

describe('createApiClient', () => {
  it('calls the production API by default', async () => {
    const { api, requests } = clientReturning(Response.json({ chainId: 314 }))
    const status = unwrap(
      await api.GET('/{network}/status', {
        params: { path: { network: 'mainnet' } },
      })
    )
    assert.equal(requests[0]?.url, 'https://api.filecoin.io/mainnet/status')
    assert.deepEqual(status, { chainId: 314 })
  })
})

describe('unwrap', () => {
  it('throws the API error code and message', async () => {
    const { api } = clientReturning(
      Response.json(
        { error: { code: 'not_found', message: 'Provider not found' } },
        { status: 404 }
      )
    )
    const result = await api.GET('/{network}/providers/{providerId}', {
      params: { path: { network: 'mainnet', providerId: '1' } },
    })
    assert.throws(
      () => unwrap(result),
      (error) =>
        ApiError.isNotFound(error) &&
        error.code === 'not_found' &&
        error.message === 'Provider not found'
    )
  })

  it('falls back to the HTTP status text', async () => {
    const { api } = clientReturning(
      new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' })
    )
    const result = await api.GET('/{network}/status', {
      params: { path: { network: 'mainnet' } },
    })
    assert.throws(
      () => unwrap(result),
      new ApiError(502, 'http_error', 'Bad Gateway')
    )
  })
})

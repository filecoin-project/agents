import { describe, expect, it } from 'vitest'
import { createApp, openApiConfig } from '../src/app.ts'
import { testApp } from './helpers.ts'

interface OpenApiDoc {
  openapi: string
  paths: Record<
    string,
    Record<string, { operationId?: string; parameters?: { name: string }[] }>
  >
}

describe('openapi', () => {
  it('documents every network route', async () => {
    const { request } = testApp()
    const doc = (await (await request('/openapi.json')).json()) as OpenApiDoc
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/v1/{network}/status',
        '/v1/{network}/providers',
        '/v1/{network}/providers/{providerId}',
        '/v1/{network}/data-sets',
        '/v1/{network}/data-sets/{dataSetId}',
        '/v1/{network}/data-sets/{dataSetId}/pieces',
        '/v1/{network}/data-sets/{dataSetId}/pieces/{pieceId}',
        '/v1/{network}/pieces',
        '/v1/{network}/rails',
        '/v1/{network}/rails/{railId}',
        '/v1/{network}/rails/{railId}/settlements',
        '/v1/{network}/session-keys',
        '/v1/{network}/session-keys/history',
        '/get/{cid}',
      ].sort()
    )
    const params = doc.paths['/v1/{network}/pieces']?.get?.parameters?.map(
      (p) => p.name
    )
    expect(params).toEqual(
      expect.arrayContaining([
        'network',
        'owner',
        'cid',
        'provider_id',
        'limit',
      ])
    )
  })

  it('lists the version in every data route path', async () => {
    const { request } = testApp()
    const doc = (await (await request('/openapi.json')).json()) as OpenApiDoc
    const unversioned = Object.keys(doc.paths).filter(
      (path) => path.startsWith('/{network}') || path.startsWith('/:network')
    )
    expect(unversioned).toEqual([])
  })

  it('gives every operation a unique operationId', async () => {
    const { request } = testApp()
    const doc = (await (await request('/openapi.json')).json()) as OpenApiDoc
    const ids = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId)
    )
    expect(ids).toHaveLength(14)
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // @filecoin-project/api-client generates its types from this file. Run
  // `pnpm gen:openapi` to update it after changing a route or schema.
  it('matches the committed openapi.json', async () => {
    const doc = createApp().getOpenAPI31Document(
      openApiConfig('https://api.filecoin.io')
    )
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot(
      '../openapi.json'
    )
  })

  it('serves the API reference', async () => {
    const { request } = testApp()
    const res = await request('/docs')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('/openapi.json')
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { awaitOnServer } from '../src/lib/server-prefetch.ts'

describe('awaitOnServer', () => {
  it('returns the prefetch on the server, so the loader waits for it', () => {
    const prefetch = Promise.resolve()
    assert.equal(awaitOnServer(prefetch, true), prefetch)
  })

  it('returns nothing in the browser, so navigation does not wait', () => {
    assert.equal(awaitOnServer(Promise.resolve(), false), undefined)
  })

  it('treats Node as the server by default', () => {
    const prefetch = Promise.resolve()
    assert.equal(awaitOnServer(prefetch), prefetch)
  })
})

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { withSignal } from '@filoz/synapse-core/utils'
import { custom, http } from 'viem'
import { driverOf } from '../src/handlers/context.ts'

test('a signal-bound transport rejects in-flight and later requests on abort', async () => {
  let calls = 0
  const hanging = custom({
    request: () => {
      calls++
      return new Promise(() => undefined)
    },
  })
  const controller = new AbortController()
  const transport = withSignal(hanging, controller.signal)({ retryCount: 0 })

  const inflight = transport.request({ method: 'eth_blockNumber' })
  controller.abort('SIGTERM')
  await assert.rejects(inflight, { name: 'AbortError' })
  await assert.rejects(transport.request({ method: 'eth_blockNumber' }), {
    name: 'AbortError',
  })
  assert.equal(calls, 1, 'no request starts after the abort')
})

test('a signal-bound http transport keeps its request timeout', {
  timeout: 5000,
}, async () => {
  // Accepts connections but never answers, like a stuck RPC endpoint.
  const server = createServer(() => undefined)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  after(() => {
    server.closeAllConnections()
    server.close()
  })
  const { port } = server.address() as AddressInfo
  const transport = withSignal(
    http(`http://127.0.0.1:${port}`, { timeout: 200, retryCount: 0 }),
    new AbortController().signal
  )({})

  await assert.rejects(transport.request({ method: 'eth_blockNumber' }), {
    name: 'TimeoutError',
  })
})

test('driverOf names the agent, a human, or automation', () => {
  assert.equal(driverOf({ agent: 'codex', interactive: false }), 'codex')
  assert.equal(driverOf({ agent: false, interactive: true }), 'human')
  assert.equal(driverOf({ agent: false, interactive: false }), 'automation')
})

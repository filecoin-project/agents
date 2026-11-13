import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FwssPermissions } from '@filoz/synapse-core/session-key'
import { type Address, parseUnits } from 'viem'
import {
  buildAuthorizeUrl,
  buildConsoleUrl,
  buildFundingUrl,
  buildRevokeUrl,
  classifyScopes,
  targetBalance,
} from '../src/auth/login.ts'
import { loginCommand } from '../src/auth/session.ts'

const SIGNER = '0x2222222222222222222222222222222222222222' as Address

test('buildAuthorizeUrl matches the Filecoin Pay console setup link', () => {
  const url = new URL(
    buildAuthorizeUrl({
      consoleUrl: 'https://pay.example',
      address: '0xAbCdEf0000000000000000000000000000000001',
      scopes: ['createDataSet', 'addPieces'],
      network: 'calibration',
      name: 'filecoin on laptop',
      days: 7,
    })
  )
  assert.equal(url.pathname, '/console/setup')
  assert.equal(url.searchParams.get('network'), 'calibration')
  assert.equal(url.searchParams.get('approval'), 'unlimited')
  assert.equal(
    url.searchParams.get('authorize'),
    '0xabcdef0000000000000000000000000000000001'
  )
  assert.equal(url.searchParams.get('scopes'), 'createDataSet,addPieces')
  assert.equal(url.searchParams.get('name'), 'filecoin on laptop')
  assert.equal(url.searchParams.get('days'), '7')
})

test('buildAuthorizeUrl leaves out an unset name and expiry', () => {
  const url = new URL(
    buildAuthorizeUrl({
      consoleUrl: 'https://pay.example',
      address: SIGNER,
      scopes: ['addPieces'],
      network: 'mainnet',
    })
  )
  assert.equal(url.searchParams.has('name'), false)
  assert.equal(url.searchParams.has('days'), false)
})

test('buildRevokeUrl matches the Filecoin Pay console revoke link', () => {
  assert.equal(
    buildRevokeUrl({
      consoleUrl: 'https://pay.example',
      address: '0xAbCdEf0000000000000000000000000000000001',
      network: 'mainnet',
    }),
    'https://pay.example/console/session-keys?revoke=0xabcdef0000000000000000000000000000000001&network=mainnet'
  )
})

test('buildConsoleUrl links the console home without a network', () => {
  assert.equal(
    buildConsoleUrl({ consoleUrl: 'https://pay.example/base' }),
    'https://pay.example/console'
  )
})

test('buildFundingUrl asks for the unlimited approval and the deposit', () => {
  const url = new URL(
    buildFundingUrl({
      consoleUrl: 'https://pay.example',
      network: 'mainnet',
      deposit: parseUnits('1.5', 18),
      balance: parseUnits('4', 18),
    })
  )
  assert.equal(url.pathname, '/console/setup')
  assert.equal(url.searchParams.get('network'), 'mainnet')
  assert.equal(url.searchParams.get('approval'), 'unlimited')
  assert.equal(url.searchParams.get('deposit'), '1.5')
  assert.equal(url.searchParams.get('balance'), '4')
})

test('buildFundingUrl without a deposit asks only for the approval', () => {
  assert.equal(
    buildFundingUrl({
      consoleUrl: 'https://pay.example',
      network: 'mainnet',
      deposit: 0n,
      balance: parseUnits('4', 18),
    }),
    'https://pay.example/console/setup?network=mainnet&approval=unlimited'
  )
})

test('console links carry the analytics tags of their flow', () => {
  const tags = { driver: 'claude-code' }
  const links = {
    login: buildAuthorizeUrl({
      consoleUrl: 'https://pay.example',
      address: SIGNER,
      scopes: ['addPieces'],
      network: 'mainnet',
      tags,
    }),
    fund: buildFundingUrl({
      consoleUrl: 'https://pay.example',
      network: 'mainnet',
      deposit: parseUnits('1', 18),
      tags,
    }),
    revoke: buildRevokeUrl({
      consoleUrl: 'https://pay.example',
      address: SIGNER,
      network: 'mainnet',
      tags,
    }),
    console: buildConsoleUrl({ consoleUrl: 'https://pay.example', tags }),
  }
  for (const [flow, link] of Object.entries(links)) {
    const params = new URL(link).searchParams
    assert.equal(params.get('utm_source'), 'filecoin-cli')
    assert.equal(params.get('utm_medium'), 'cli')
    assert.equal(params.get('utm_term'), flow)
    assert.equal(params.get('utm_content'), 'claude-code')
    assert.equal(params.has('utm_campaign'), false)
  }
})

test('console links without a driver leave out utm_content', () => {
  const params = new URL(
    buildFundingUrl({
      consoleUrl: 'https://pay.example',
      network: 'mainnet',
      tags: {},
    })
  ).searchParams
  assert.equal(params.get('utm_term'), 'fund')
  assert.equal(params.has('utm_content'), false)
})

test('targetBalance takes the debt a deposit settles first', () => {
  const unit = 10n ** 18n
  assert.equal(
    targetBalance({ availableFunds: 2n * unit, debt: 0n, depositNeeded: unit }),
    3n * unit
  )
  assert.equal(
    targetBalance({ availableFunds: 0n, debt: unit, depositNeeded: 3n * unit }),
    2n * unit
  )
})

test('classifyScopes splits live and missing scopes', () => {
  const grants = classifyScopes(
    ['createDataSet', 'addPieces', 'schedulePieceRemovals'],
    {
      [FwssPermissions.createDataSet]: 200n,
      [FwssPermissions.addPieces]: 150n,
      [FwssPermissions.schedulePieceRemovals]: 50n,
    },
    100n
  )
  assert.deepEqual(grants, {
    granted: ['createDataSet', 'addPieces'],
    missing: ['schedulePieceRemovals'],
    expiresAt: 150n,
  })
})

test('loginCommand spells out fresh and scopes', () => {
  assert.equal(loginCommand(), 'filecoin login')
  assert.equal(
    loginCommand({ fresh: true, scopes: ['createDataSet', 'addPieces'] }),
    'filecoin login --fresh --scopes createDataSet --scopes addPieces'
  )
})

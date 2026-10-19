import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_SCOPES,
  expiryFromDays,
  parseAmount,
  parseScopes,
  parseSetupLink,
  setupSearchSchema,
  toSetupSearch,
} from '../src/lib/setup-request.ts'

const SIGNER = '0x000000000000000000000000000000000000dEaD'
const LOWER = SIGNER.toLowerCase()

describe('setupSearchSchema', () => {
  it('keeps raw strings and drops values of other types', () => {
    assert.deepEqual(
      setupSearchSchema.parse({
        network: 'calibration',
        days: 7,
        deposit: '1',
      }),
      { network: 'calibration', days: undefined, deposit: '1' }
    )
  })
})

describe('parseSetupLink', () => {
  it('reads a bare link as no request', () => {
    assert.deepEqual(parseSetupLink({}), {
      network: null,
      sessionKey: null,
      deposit: null,
      balance: null,
      approvalOnly: false,
      unlimitedApproval: false,
    })
  })

  it('reads a login link from the console contract', () => {
    assert.deepEqual(
      parseSetupLink({
        network: 'calibration',
        approval: 'unlimited',
        authorize: SIGNER,
        scopes: 'addPieces,createDataSet',
        name: ' filecoin-cli ',
        days: '7',
      }),
      {
        network: 'calibration',
        sessionKey: {
          address: LOWER,
          scopes: ['createDataSet', 'addPieces'],
          name: 'filecoin-cli',
          days: 7,
        },
        deposit: null,
        balance: null,
        approvalOnly: true,
        unlimitedApproval: true,
      }
    )
  })

  it('reads signer as authorize', () => {
    const request = parseSetupLink({
      network: 'mainnet',
      signer: LOWER,
      scopes: 'addpieces',
    })
    assert.ok(!('error' in request))
    assert.equal(request.sessionKey?.address, LOWER)
    assert.deepEqual(request.sessionKey?.scopes, ['addPieces'])
  })

  it('reads a funding link', () => {
    assert.deepEqual(
      parseSetupLink({
        network: 'calibration',
        approval: 'unlimited',
        deposit: '2',
        balance: '2.5',
      }),
      {
        network: 'calibration',
        sessionKey: null,
        deposit: '2',
        balance: '2.5',
        approvalOnly: false,
        unlimitedApproval: true,
      }
    )
  })

  it('reads an operator link as approval only', () => {
    const request = parseSetupLink({ network: 'calibration', operator: 'FWSS' })
    assert.ok(!('error' in request))
    assert.equal(request.approvalOnly, true)
    assert.equal(request.unlimitedApproval, false)
  })

  it('falls back on an unusable name or days', () => {
    const request = parseSetupLink({
      network: 'calibration',
      authorize: LOWER,
      scopes: 'addPieces',
      name: '   ',
      days: '0',
    })
    assert.ok(!('error' in request))
    assert.equal(request.sessionKey?.name, null)
    assert.equal(request.sessionKey?.days, null)
    const capped = parseSetupLink({
      network: 'calibration',
      authorize: LOWER,
      scopes: 'addPieces',
      days: '9000',
    })
    assert.ok(!('error' in capped))
    assert.equal(capped.sessionKey?.days, 365)
  })

  it('refuses the whole link on a value it cannot read', () => {
    const cases: [Record<string, string>, string][] = [
      [
        { network: 'calibration', authorize: '0x1234', scopes: 'addPieces' },
        'not-an-address',
      ],
      [{ network: 'calibration', scopes: 'addPieces' }, 'not-an-address'],
      [
        {
          network: 'calibration',
          authorize: SIGNER.replace('dEaD', 'DeAd'),
          scopes: 'addPieces',
        },
        'bad-checksum',
      ],
      [{ authorize: LOWER, scopes: 'addPieces' }, 'no-network'],
      [{ network: 'devnet', deposit: '1' }, 'no-network'],
      [{ deposit: '1' }, 'no-network'],
      [{ network: 'calibration', authorize: LOWER }, 'no-scopes'],
      [
        { network: 'calibration', authorize: LOWER, scopes: 'transferFunds' },
        'no-scopes',
      ],
      [{ network: 'calibration', deposit: '0' }, 'bad-deposit'],
      [{ network: 'calibration', deposit: '' }, 'bad-deposit'],
      [{ network: 'calibration', balance: '1e3' }, 'bad-balance'],
      [{ network: 'calibration', operator: 'pdp' }, 'bad-operator'],
      [{ network: 'calibration', approval: 'max' }, 'bad-approval'],
    ]
    for (const [search, error] of cases) {
      assert.deepEqual(
        parseSetupLink(search),
        { error },
        JSON.stringify(search)
      )
    }
  })
})

describe('parseAmount', () => {
  it('accepts plain positive decimals only', () => {
    assert.equal(parseAmount('1.5'), '1.5')
    assert.equal(parseAmount(' 0.01 '), '0.01')
    for (const value of ['0', '0.0', '-1', '01', '1.', '.5', '0x10', '1e3']) {
      assert.equal(parseAmount(value), null, value)
    }
  })
})

describe('scopes', () => {
  it('keeps known scopes in display order', () => {
    assert.deepEqual(parseScopes('addPieces, nope,createDataSet'), [
      'createDataSet',
      'addPieces',
    ])
    assert.equal(parseScopes('nope'), undefined)
  })
})

describe('toSetupSearch', () => {
  it('builds the search params of a valid request', () => {
    assert.deepEqual(
      toSetupSearch({
        network: 'calibration',
        signer: SIGNER,
        name: 'agent',
        scopes: ['addPieces'],
        days: 7,
        deposit: '1.5',
        balance: '2',
        unlimitedApproval: true,
      }),
      {
        search: {
          network: 'calibration',
          signer: LOWER,
          name: 'agent',
          scopes: 'addPieces',
          days: '7',
          deposit: '1.5',
          balance: '2',
          approval: 'unlimited',
        },
      }
    )
  })

  it('defaults the network and the scopes', () => {
    assert.deepEqual(toSetupSearch({ signer: LOWER }, 'mainnet'), {
      search: {
        network: 'mainnet',
        signer: LOWER,
        scopes: DEFAULT_SCOPES.join(','),
      },
    })
  })

  it('needs a network', () => {
    assert.deepEqual(toSetupSearch({ deposit: '1' }), {
      errors: ['network is required: one of mainnet, calibration.'],
    })
  })

  it('names unknown scopes', () => {
    const result = toSetupSearch(
      { signer: SIGNER, scopes: ['transferFunds'] },
      'calibration'
    )
    assert.ok('errors' in result)
    assert.match(result.errors[0], /Unknown scopes: transferFunds/)
  })

  it('reports every invalid value', () => {
    const result = toSetupSearch({
      network: 'devnet',
      signer: '0x1234',
      days: 0,
      deposit: '0',
      unlimitedApproval: 'yes',
    })
    assert.ok('errors' in result)
    assert.equal(result.errors.length, 5)
  })

  it('needs a signer for key fields', () => {
    assert.deepEqual(toSetupSearch({ days: 7 }, 'calibration'), {
      errors: ['name, scopes, and days need a signer.'],
    })
  })

  it('checks the input shape', () => {
    assert.deepEqual(toSetupSearch(null), {
      errors: ['The request must be an object.'],
    })
    assert.deepEqual(toSetupSearch({ network: 1, deposit: 2 }), {
      errors: [
        'network must be one of: mainnet, calibration.',
        'deposit must be a string.',
      ],
    })
  })

  it('round-trips through parseSetupLink', () => {
    const result = toSetupSearch({ signer: LOWER, deposit: '1' }, 'calibration')
    assert.ok('search' in result)
    const request = parseSetupLink(result.search)
    assert.ok(!('error' in request))
    assert.deepEqual(request.sessionKey?.scopes, DEFAULT_SCOPES)
    assert.equal(request.deposit, '1')
  })
})

describe('expiryFromDays', () => {
  it('adds whole days in seconds', () => {
    assert.equal(expiryFromDays(2, 1_000_500), 1000n + 172_800n)
  })
})

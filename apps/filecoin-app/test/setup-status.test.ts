import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { maxUint256, parseUnits } from 'viem'
import { SCOPE_PERMISSIONS } from '../src/lib/setup-request.ts'
import {
  approvalState,
  DEPOSIT_BASELINE_TTL_MS,
  depositPrefill,
  fundsOffer,
  isSetupComplete,
  keyGrant,
  limitShortfalls,
  REQUIRED_MAX_LOCKUP_PERIOD,
  readDepositBaseline,
  roundUpToCent,
  shortfall,
  shortfallLabel,
  unlimitedApprovalTerms,
  walletCovers,
  writeDepositBaseline,
} from '../src/lib/setup-status.ts'

const usdfc = (value: string) => parseUnits(value, 18)
const UNLIMITED = {
  isApproved: true,
  rateAllowance: maxUint256,
  lockupAllowance: maxUint256,
  maxLockupPeriod: REQUIRED_MAX_LOCKUP_PERIOD,
}

describe('keyGrant', () => {
  const scopes = ['createDataSet', 'addPieces'] as const
  it('loads, then reports none, partial and authorized', () => {
    assert.deepEqual(keyGrant(scopes, undefined, 10n), { state: 'loading' })
    assert.deepEqual(keyGrant(scopes, {}, 10n), { state: 'none' })
    assert.deepEqual(
      keyGrant(scopes, { [SCOPE_PERMISSIONS.addPieces]: 20n }, 10n),
      { state: 'partial', granted: ['addPieces'] }
    )
    assert.deepEqual(
      keyGrant(
        scopes,
        {
          [SCOPE_PERMISSIONS.createDataSet]: 30n,
          [SCOPE_PERMISSIONS.addPieces]: 20n,
        },
        10n
      ),
      { state: 'authorized', expiresAt: 20n }
    )
  })

  it('drops expired scopes', () => {
    assert.deepEqual(
      keyGrant(['addPieces'], { [SCOPE_PERMISSIONS.addPieces]: 10n }, 10n),
      { state: 'none' }
    )
  })
})

describe('approval', () => {
  it('counts any approval unless unlimited is required', () => {
    const limited = { ...UNLIMITED, rateAllowance: 1n }
    assert.equal(
      approvalState({ ...UNLIMITED, isApproved: false }, true),
      'not-approved'
    )
    assert.equal(approvalState(limited, false), 'approved')
    assert.equal(approvalState(limited, true), 'limited')
    assert.equal(approvalState(UNLIMITED, true), 'approved')
  })

  it('mirrors isFwssMaxApproved', () => {
    assert.deepEqual(limitShortfalls(UNLIMITED), {
      rate: false,
      lockup: false,
      period: false,
    })
    assert.deepEqual(
      limitShortfalls({
        ...UNLIMITED,
        rateAllowance: maxUint256 - 1n,
        lockupAllowance: maxUint256 / 2n,
        maxLockupPeriod: REQUIRED_MAX_LOCKUP_PERIOD - 1n,
      }),
      { rate: true, lockup: false, period: true }
    )
    assert.equal(
      limitShortfalls({ ...UNLIMITED, lockupAllowance: maxUint256 / 2n - 1n })
        .lockup,
      true
    )
  })

  it('keeps a longer lockup period when lifting limits', () => {
    assert.equal(
      unlimitedApprovalTerms({ ...UNLIMITED, maxLockupPeriod: 1n })
        .maxLockupPeriod,
      REQUIRED_MAX_LOCKUP_PERIOD
    )
    const longer = REQUIRED_MAX_LOCKUP_PERIOD * 2n
    assert.deepEqual(
      unlimitedApprovalTerms({ ...UNLIMITED, maxLockupPeriod: longer }),
      {
        rateAllowance: maxUint256,
        lockupAllowance: maxUint256,
        maxLockupPeriod: longer,
      }
    )
  })
})

describe('shortfall', () => {
  const base = {
    available: 0n,
    debt: 0n,
    funds: 0n,
    baseline: null,
    deposit: null,
    balance: null,
  }

  it('measures a balance target, debt included, rounded up to the cent', () => {
    assert.deepEqual(
      shortfall({ ...base, available: usdfc('1'), balance: '2.001' }),
      { kind: 'amount', amount: usdfc('1.01') }
    )
    assert.deepEqual(shortfall({ ...base, debt: usdfc('0.5'), balance: '1' }), {
      kind: 'amount',
      amount: usdfc('1.5'),
    })
    assert.deepEqual(
      shortfall({ ...base, available: usdfc('2'), balance: '2' }),
      {
        kind: 'none',
      }
    )
  })

  it('measures a deposit from the baseline', () => {
    const deposit = { ...base, deposit: '2', funds: usdfc('5') }
    assert.deepEqual(shortfall(deposit), { kind: 'amount', amount: usdfc('2') })
    assert.deepEqual(shortfall({ ...deposit, baseline: usdfc('4') }), {
      kind: 'amount',
      amount: usdfc('1'),
    })
    assert.deepEqual(shortfall({ ...deposit, baseline: usdfc('3') }), {
      kind: 'none',
    })
    // A settled rail lowers funds: ask for that much more, never less than nothing.
    assert.deepEqual(shortfall({ ...deposit, baseline: usdfc('6') }), {
      kind: 'amount',
      amount: usdfc('2'),
    })
  })

  it('asks for any balance without an amount', () => {
    assert.deepEqual(shortfall(base), { kind: 'any' })
    assert.deepEqual(shortfall({ ...base, available: 1n }), { kind: 'none' })
  })

  it('rounds up to the cent', () => {
    assert.equal(roundUpToCent(1n), 10n ** 16n)
    assert.equal(roundUpToCent(10n ** 16n), 10n ** 16n)
  })
})

describe('funds offer', () => {
  const ready = (balance: bigint) => ({ state: 'ready' as const, balance })
  const missing = { kind: 'amount' as const, amount: usdfc('2') }

  it('waits for reads', () => {
    assert.equal(
      fundsOffer({
        missing: null,
        walletUsdfc: ready(0n),
        approval: 'approved',
      }),
      'checking'
    )
    assert.equal(
      fundsOffer({
        missing,
        walletUsdfc: { state: 'loading' },
        approval: 'approved',
      }),
      'checking'
    )
    assert.equal(
      fundsOffer({
        missing,
        walletUsdfc: ready(usdfc('2')),
        approval: 'unreadable',
      }),
      'checking'
    )
  })

  it('picks the offer from the wallet and the approval', () => {
    assert.equal(
      fundsOffer({
        missing: { kind: 'none' },
        walletUsdfc: ready(0n),
        approval: 'loading',
      }),
      'done'
    )
    assert.equal(
      fundsOffer({
        missing,
        walletUsdfc: ready(usdfc('1')),
        approval: 'approved',
      }),
      'get-usdfc'
    )
    assert.equal(
      fundsOffer({
        missing,
        walletUsdfc: { state: 'unreadable' },
        approval: 'approved',
      }),
      'get-usdfc'
    )
    assert.equal(
      fundsOffer({
        missing,
        walletUsdfc: ready(usdfc('2')),
        approval: 'not-approved',
      }),
      'with-approval'
    )
    assert.equal(
      fundsOffer({
        missing,
        walletUsdfc: ready(usdfc('2')),
        approval: 'limited',
      }),
      'deposit'
    )
  })

  it('labels and prefills the shortfall', () => {
    assert.equal(walletCovers({ kind: 'any' }, 1n), true)
    assert.equal(walletCovers({ kind: 'any' }, 0n), false)
    assert.equal(depositPrefill(missing), '2')
    assert.equal(depositPrefill({ kind: 'any' }), '')
    assert.equal(shortfallLabel(missing), '2 USDFC')
    assert.equal(shortfallLabel({ kind: 'any' }), 'USDFC')
  })
})

describe('isSetupComplete', () => {
  it('needs every requested step', () => {
    const done = {
      keyRequested: true,
      grant: { state: 'authorized' as const, expiresAt: 1n },
      approved: true,
      fundsCovered: true,
    }
    assert.equal(isSetupComplete(done), true)
    assert.equal(isSetupComplete({ ...done, grant: { state: 'none' } }), false)
    assert.equal(
      isSetupComplete({
        ...done,
        keyRequested: false,
        grant: { state: 'none' },
      }),
      true
    )
    assert.equal(isSetupComplete({ ...done, approved: false }), false)
    assert.equal(isSetupComplete({ ...done, fundsCovered: false }), false)
  })
})

describe('deposit baseline', () => {
  it('round-trips while in date', () => {
    const stored = writeDepositBaseline(42n, 1000)
    assert.equal(readDepositBaseline(stored, 1000), 42n)
    assert.equal(
      readDepositBaseline(stored, 1000 + DEPOSIT_BASELINE_TTL_MS),
      42n
    )
    assert.equal(
      readDepositBaseline(stored, 1001 + DEPOSIT_BASELINE_TTL_MS),
      null
    )
    assert.equal(readDepositBaseline(stored, 999), null)
  })

  it('ignores malformed values', () => {
    for (const stored of [
      null,
      'nope',
      '1',
      '{"baseline":1,"savedAt":0}',
      '{"baseline":"x","savedAt":0}',
    ]) {
      assert.equal(readDepositBaseline(stored, 0), null, String(stored))
    }
  })
})

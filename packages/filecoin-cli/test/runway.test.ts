import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibration } from '@filoz/synapse-core/chains'
import { maxUint256 } from 'viem'
import { describeRunway } from '../src/runway.ts'

/** Epochs per day: one every 30 seconds. */
const DAY = 2880n
const GENESIS = calibration.genesisTimestamp
/** The epoch the account summary was read at. */
const EPOCH = 4_172_707n

test('an account spending nothing is healthy with no runway', () => {
  assert.deepEqual(
    describeRunway(
      {
        runwayInEpochs: maxUint256,
        lockupRatePerEpoch: 0n,
        debt: 0n,
        epoch: EPOCH,
      },
      GENESIS
    ),
    { health: 'healthy' }
  )
})

test('runway over 14 days is healthy and dated from the summary epoch', () => {
  const runwayInEpochs = 30n * DAY + 100n
  assert.deepEqual(
    describeRunway(
      { runwayInEpochs, lockupRatePerEpoch: 1n, debt: 0n, epoch: EPOCH },
      GENESIS
    ),
    {
      health: 'healthy',
      runwayDays: 30,
      fundedUntil: new Date(
        (GENESIS + Number(EPOCH + runwayInEpochs) * 30) * 1000
      ).toISOString(),
    }
  )
})

test('fundedUntil does not depend on when it is computed', () => {
  const summary = {
    runwayInEpochs: 30n * DAY,
    lockupRatePerEpoch: 1n,
    debt: 0n,
    epoch: EPOCH,
  }
  const first = describeRunway(summary, GENESIS).fundedUntil
  const later = describeRunway({ ...summary }, GENESIS).fundedUntil
  assert.equal(later, first)
  // One more epoch of chain time moves the date by 30 seconds.
  const next = describeRunway({ ...summary, epoch: EPOCH + 1n }, GENESIS)
  assert.equal(
    Date.parse(next.fundedUntil ?? '') - Date.parse(first ?? ''),
    30_000
  )
})

test('runway of 14 days or less is a warning', () => {
  const { health, runwayDays } = describeRunway(
    {
      runwayInEpochs: 14n * DAY,
      lockupRatePerEpoch: 1n,
      debt: 0n,
      epoch: EPOCH,
    },
    GENESIS
  )
  assert.equal(health, 'warning')
  assert.equal(runwayDays, 14)
})

test('no runway or any debt is a deficit', () => {
  assert.equal(
    describeRunway(
      { runwayInEpochs: 0n, lockupRatePerEpoch: 1n, debt: 0n, epoch: EPOCH },
      GENESIS
    ).health,
    'deficit'
  )
  assert.equal(
    describeRunway(
      {
        runwayInEpochs: maxUint256,
        lockupRatePerEpoch: 0n,
        debt: 1n,
        epoch: EPOCH,
      },
      GENESIS
    ).health,
    'deficit'
  )
})

test('a runway past the last valid date has no fundedUntil', () => {
  const runway = describeRunway(
    {
      runwayInEpochs: 10n ** 20n,
      lockupRatePerEpoch: 1n,
      debt: 0n,
      epoch: EPOCH,
    },
    GENESIS
  )
  assert.equal(runway.health, 'healthy')
  assert.equal(runway.fundedUntil, undefined)
})

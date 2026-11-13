import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maxUint256 } from 'viem'
import { describeRunway } from '../src/runway.ts'

/** Epochs per day: one every 30 seconds. */
const DAY = 2880n
/** When the account enters deficit, as synapse-core reports it. */
const FUNDED_UNTIL = new Date('2026-12-13T12:00:00.000Z')

test('an account spending nothing is healthy with no runway', () => {
  assert.deepEqual(
    describeRunway({
      runwayInEpochs: maxUint256,
      lockupRatePerEpoch: 0n,
      debt: 0n,
      fundedUntil: null,
    }),
    { health: 'healthy' }
  )
})

test('runway over 14 days is healthy and reports when it ends', () => {
  assert.deepEqual(
    describeRunway({
      runwayInEpochs: 30n * DAY + 100n,
      lockupRatePerEpoch: 1n,
      debt: 0n,
      fundedUntil: FUNDED_UNTIL,
    }),
    {
      health: 'healthy',
      runwayDays: 30,
      fundedUntil: FUNDED_UNTIL.toISOString(),
    }
  )
})

test('runway of 14 days or less is a warning', () => {
  const { health, runwayDays } = describeRunway({
    runwayInEpochs: 14n * DAY,
    lockupRatePerEpoch: 1n,
    debt: 0n,
    fundedUntil: FUNDED_UNTIL,
  })
  assert.equal(health, 'warning')
  assert.equal(runwayDays, 14)
})

test('no runway or any debt is a deficit', () => {
  assert.equal(
    describeRunway({
      runwayInEpochs: 0n,
      lockupRatePerEpoch: 1n,
      debt: 0n,
      fundedUntil: FUNDED_UNTIL,
    }).health,
    'deficit'
  )
  assert.equal(
    describeRunway({
      runwayInEpochs: maxUint256,
      lockupRatePerEpoch: 0n,
      debt: 1n,
      fundedUntil: null,
    }).health,
    'deficit'
  )
})

test('a runway past the last valid date has no fundedUntil', () => {
  const runway = describeRunway({
    runwayInEpochs: 10n ** 20n,
    lockupRatePerEpoch: 1n,
    debt: 0n,
    fundedUntil: null,
  })
  assert.equal(runway.health, 'healthy')
  assert.equal(runway.runwayDays, Number(10n ** 20n / DAY))
  assert.equal(runway.fundedUntil, undefined)
})

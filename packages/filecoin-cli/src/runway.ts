import { TIME_CONSTANTS } from '@filoz/synapse-core/utils'

/** Runway at or under which the account is in `warning`: 14 days. */
const WARNING_EPOCHS = TIME_CONSTANTS.EPOCHS_PER_DAY * 14n

/** Milliseconds per epoch. */
const EPOCH_MS = BigInt(TIME_CONSTANTS.EPOCH_DURATION * 1000)

/** Latest time a `Date` can hold, in milliseconds since the epoch. */
const MAX_DATE_MS = 8_640_000_000_000_000n

/**
 * Account health: `deficit` once the account owes debt or its available funds
 * are spent, `warning` with 14 days or less left, `healthy` otherwise. The
 * thresholds match filecoin-pin's `payments status`.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/master/src/payments/status.ts
 */
export type Health = 'healthy' | 'warning' | 'deficit'

/** How long the account's available funds last at its current spend. */
export type Runway = {
  health: Health
  /** Whole days until the account enters deficit; absent when nothing is being spent. */
  runwayDays?: number
  /** When the account enters deficit, as an ISO 8601 time; absent when nothing is being spent or the date is out of range. */
  fundedUntil?: string
}

/**
 * Derive the {@link Runway} from `Pay.getAccountSummary` fields. synapse-core
 * reports `runwayInEpochs` as `maxUint256` when the lockup rate is zero, so a
 * zero rate means no runway at all rather than a far-future date.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/pay/get-account-summary.ts
 */
export function describeRunway(
  summary: {
    runwayInEpochs: bigint
    lockupRatePerEpoch: bigint
    debt: bigint
  },
  now: number = Date.now()
): Runway {
  const { runwayInEpochs, lockupRatePerEpoch, debt } = summary
  const spending = lockupRatePerEpoch > 0n
  const health: Health =
    debt > 0n || (spending && runwayInEpochs === 0n)
      ? 'deficit'
      : spending && runwayInEpochs <= WARNING_EPOCHS
        ? 'warning'
        : 'healthy'
  if (!spending) return { health }
  const runwayDays = Number(runwayInEpochs / TIME_CONSTANTS.EPOCHS_PER_DAY)
  const until = BigInt(now) + runwayInEpochs * EPOCH_MS
  return until > MAX_DATE_MS
    ? { health, runwayDays }
    : { health, runwayDays, fundedUntil: new Date(Number(until)).toISOString() }
}

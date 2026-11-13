import { TIME_CONSTANTS } from '@filoz/synapse-core/utils'

/** Runway at or under which the account is in `warning`: 14 days. */
const WARNING_EPOCHS = TIME_CONSTANTS.EPOCHS_PER_DAY * 14n

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
  /** When the account enters deficit, as an ISO 8601 time; absent when nothing is being spent or the date is out of range. Derived from the chain epoch, not the local clock. */
  fundedUntil?: string
}

/**
 * Derive the {@link Runway} from `Pay.getAccountSummary` fields. synapse-core
 * reports `runwayInEpochs` as `maxUint256` when the lockup rate is zero, so a
 * zero rate means no runway at all rather than a far-future date.
 *
 * synapse-core dates `fundedUntil` from the summary's epoch and the chain's
 * genesis, so it stays right when the summary takes long to read, and is
 * `null` past the `Date` range.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/pay/get-account-summary.ts
 */
export function describeRunway(summary: {
  runwayInEpochs: bigint
  lockupRatePerEpoch: bigint
  debt: bigint
  fundedUntil: Date | null
}): Runway {
  const { runwayInEpochs, lockupRatePerEpoch, debt, fundedUntil } = summary
  const spending = lockupRatePerEpoch > 0n
  const health: Health =
    debt > 0n || (spending && runwayInEpochs === 0n)
      ? 'deficit'
      : spending && runwayInEpochs <= WARNING_EPOCHS
        ? 'warning'
        : 'healthy'
  if (!spending) return { health }
  const runwayDays = Number(runwayInEpochs / TIME_CONSTANTS.EPOCHS_PER_DAY)
  return fundedUntil
    ? { health, runwayDays, fundedUntil: fundedUntil.toISOString() }
    : { health, runwayDays }
}

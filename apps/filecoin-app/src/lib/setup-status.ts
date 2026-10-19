import type { Expirations } from '@filoz/synapse-core/session-key'
import { formatUnits, maxUint256 } from 'viem'
import { EPOCHS_PER_MONTH, parseUnitsSafe } from './format.ts'
import { SCOPE_PERMISSIONS, type ScopeId } from './setup-request.ts'

/**
 * How often the setup page rereads what it shows, so work done in another
 * tab or by the tool appears.
 */
export const SETUP_POLL_MS = 15_000

/** Poll interval once a session key holds every scope: only a revoke or expiry can change it. */
export const AUTHORIZED_POLL_MS = 60_000

/**
 * The lockup period a Warm Storage approval must allow: FWSS reserves 30
 * days of charges, matching the price list's `defaultLockupPeriod`.
 */
export const REQUIRED_MAX_LOCKUP_PERIOD = EPOCHS_PER_MONTH

/** A requested session key's grant, as the registry reports it. */
export type KeyGrant =
  | { state: 'loading' }
  | { state: 'unreadable' }
  | { state: 'none' }
  | { state: 'partial'; granted: ScopeId[] }
  /** Every requested scope is live; `expiresAt` is the earliest expiry, in Unix seconds. */
  | { state: 'authorized'; expiresAt: bigint }

/**
 * Grant state of the requested scopes. A scope counts while its expiry is in
 * the future.
 *
 * @param scopes - Requested scopes.
 * @param expirations - Expiries read from the registry; `undefined` while loading.
 * @param now - Unix time in seconds.
 */
export function keyGrant(
  scopes: readonly ScopeId[],
  expirations: Partial<Expirations> | undefined,
  now: bigint
): Exclude<KeyGrant, { state: 'unreadable' }> {
  if (!expirations) return { state: 'loading' }
  const granted: ScopeId[] = []
  let expiresAt: bigint | undefined
  for (const scope of scopes) {
    const expiry = expirations[SCOPE_PERMISSIONS[scope]] ?? 0n
    if (expiry > now) {
      granted.push(scope)
      if (expiresAt === undefined || expiry < expiresAt) expiresAt = expiry
    }
  }
  if (granted.length === 0) return { state: 'none' }
  if (granted.length < scopes.length || expiresAt === undefined) {
    return { state: 'partial', granted }
  }
  return { state: 'authorized', expiresAt }
}

/** An account's Filecoin Pay approval of Warm Storage, as `operatorApprovals` returns it. */
export interface OperatorApprovalTerms {
  isApproved: boolean
  rateAllowance: bigint
  lockupAllowance: bigint
  maxLockupPeriod: bigint
}

/**
 * Where the Warm Storage approval stands for a request. `limited` exists
 * only when the request asks for an unlimited approval.
 */
export type ApprovalState =
  | 'loading'
  | 'unreadable'
  | 'not-approved'
  | 'limited'
  | 'approved'

/**
 * Which allowances fall short of what tools built on synapse-core need
 * before they upload, mirroring its `isFwssMaxApproved`: an exactly
 * unlimited rate, a lockup above half of unlimited (one-time payments such as
 * CDN egress draw it down), and a lockup period that covers the service's.
 *
 * @param terms - The current approval.
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/pay/is-fwss-max-approved.ts
 */
export function limitShortfalls(terms: OperatorApprovalTerms) {
  return {
    rate: terms.rateAllowance !== maxUint256,
    lockup: terms.lockupAllowance < maxUint256 / 2n,
    period: terms.maxLockupPeriod < REQUIRED_MAX_LOCKUP_PERIOD,
  }
}

/**
 * Approval state for a request.
 *
 * @param terms - The current approval.
 * @param unlimitedRequired - Whether the request asks for `approval=unlimited`.
 */
export function approvalState(
  terms: OperatorApprovalTerms,
  unlimitedRequired: boolean
): ApprovalState {
  if (!terms.isApproved) return 'not-approved'
  if (!unlimitedRequired) return 'approved'
  const short = limitShortfalls(terms)
  return short.rate || short.lockup || short.period ? 'limited' : 'approved'
}

/**
 * `setOperatorApproval` allowances that lift every limit. A longer lockup
 * period the owner already allows is kept.
 *
 * @param current - The current approval.
 */
export function unlimitedApprovalTerms(current: OperatorApprovalTerms) {
  return {
    rateAllowance: maxUint256,
    lockupAllowance: maxUint256,
    maxLockupPeriod:
      current.maxLockupPeriod > REQUIRED_MAX_LOCKUP_PERIOD
        ? current.maxLockupPeriod
        : REQUIRED_MAX_LOCKUP_PERIOD,
  }
}

/**
 * What Filecoin Pay still lacks for a request: nothing, a USDFC amount in
 * base units, or some balance at all.
 */
export type Shortfall =
  | { kind: 'none' }
  | { kind: 'amount'; amount: bigint }
  | { kind: 'any' }

/** One cent of USDFC, in base units: shortfalls against a balance round up to it. */
const CENT = 10n ** 16n

/**
 * Round base units up to the next cent.
 *
 * @param value - Amount in base units.
 */
export function roundUpToCent(value: bigint) {
  return ((value + CENT - 1n) / CENT) * CENT
}

/**
 * What still has to go into Filecoin Pay for a request:
 * - With a `balance`, the gap to that target. Debt counts too, because a
 *   deposit settles it first. Rounded up to the cent: lockup keeps drawing
 *   the balance down, and a deposit that lands a fraction short would leave
 *   the step open.
 * - With only a `deposit`, the part of it this tab has not seen go in: the
 *   account's `funds` against `baseline`, their value when the page first
 *   opened. Deposits raise `funds` and lockup does not move it. Until the
 *   baseline is known, the whole amount.
 * - With neither, some balance until there is any.
 *
 * @param options.available - Available funds, in base units.
 * @param options.debt - What the account owes beyond its funds.
 * @param options.funds - The account's funds before lockup.
 * @param options.baseline - `funds` when the page first opened, or `null`.
 * @param options.deposit - The request's decimal deposit, or `null`.
 * @param options.balance - The request's decimal balance target, or `null`.
 */
export function shortfall(options: {
  available: bigint
  debt: bigint
  funds: bigint
  baseline: bigint | null
  deposit: string | null
  balance: string | null
}): Shortfall {
  const { available, debt, funds, baseline, deposit, balance } = options
  if (balance !== null) {
    const missing = (parseUnitsSafe(balance) ?? 0n) + debt - available
    return missing > 0n
      ? { kind: 'amount', amount: roundUpToCent(missing) }
      : { kind: 'none' }
  }
  if (deposit !== null) {
    const amount = parseUnitsSafe(deposit) ?? 0n
    const added = baseline === null ? 0n : funds - baseline
    return added >= amount
      ? { kind: 'none' }
      : { kind: 'amount', amount: amount - (added > 0n ? added : 0n) }
  }
  return available > 0n ? { kind: 'none' } : { kind: 'any' }
}

/**
 * Whether the wallet's own USDFC can make up the shortfall.
 *
 * @param missing - {@link Shortfall}
 * @param walletUsdfc - Wallet USDFC balance, in base units.
 */
export function walletCovers(missing: Shortfall, walletUsdfc: bigint) {
  if (missing.kind === 'none') return true
  if (missing.kind === 'any') return walletUsdfc > 0n
  return walletUsdfc >= missing.amount
}

/**
 * The decimal amount a deposit form opens with: the shortfall, or empty for
 * the owner to choose.
 *
 * @param missing - {@link Shortfall}
 */
export function depositPrefill(missing: Shortfall) {
  return missing.kind === 'amount' ? formatUnits(missing.amount, 18) : ''
}

/**
 * The shortfall as the steps name it: `2.5 USDFC`, or `USDFC` when any
 * amount will do.
 *
 * @param missing - {@link Shortfall}
 */
export function shortfallLabel(missing: Shortfall) {
  return missing.kind === 'amount'
    ? `${depositPrefill(missing)} USDFC`
    : 'USDFC'
}

/** A read the steps depend on. */
export type Read<T> =
  | { state: 'loading' }
  | { state: 'unreadable' }
  | ({ state: 'ready' } & T)

/**
 * What the funds step offers. The steps keep a fixed order (key, approval,
 * funds), and only this changes as the reads come in:
 * - `checking`: a read it depends on is still loading.
 * - `done`: Filecoin Pay holds what the request asks for.
 * - `with-approval`: the approval step deposits it in the same transaction,
 *   because Warm Storage still needs approving and the wallet holds enough.
 * - `deposit`: the wallet holds enough to deposit it.
 * - `get-usdfc`: the wallet does not, or its balance cannot be read.
 */
export type FundsOffer =
  | 'checking'
  | 'done'
  | 'with-approval'
  | 'deposit'
  | 'get-usdfc'

/**
 * Pick what the funds step offers.
 *
 * @param options.missing - {@link Shortfall}, or `null` while the Pay balance loads.
 * @param options.walletUsdfc - Wallet USDFC read.
 * @param options.approval - {@link ApprovalState}
 */
export function fundsOffer(options: {
  missing: Shortfall | null
  walletUsdfc: Read<{ balance: bigint }>
  approval: ApprovalState
}): FundsOffer {
  const { missing, walletUsdfc, approval } = options
  if (missing === null) return 'checking'
  if (missing.kind === 'none') return 'done'
  if (walletUsdfc.state === 'loading') return 'checking'
  if (
    walletUsdfc.state !== 'ready' ||
    !walletCovers(missing, walletUsdfc.balance)
  ) {
    return 'get-usdfc'
  }
  // An approval that could not be read may exist; wait like one still loading.
  if (approval === 'loading' || approval === 'unreadable') return 'checking'
  return approval === 'not-approved' ? 'with-approval' : 'deposit'
}

/**
 * Whether every step the request asks for is done.
 *
 * @param options.keyRequested - Whether the request names a session key.
 * @param options.grant - {@link KeyGrant}
 * @param options.approved - Whether Warm Storage is approved as the request needs.
 * @param options.fundsCovered - Whether funds are covered or not asked for.
 */
export function isSetupComplete(options: {
  keyRequested: boolean
  grant: KeyGrant
  approved: boolean
  fundsCovered: boolean
}) {
  return (
    (!options.keyRequested || options.grant.state === 'authorized') &&
    options.approved &&
    options.fundsCovered
  )
}

/**
 * How long a stored deposit baseline counts. A reload while the owner works
 * through the page keeps it; a request opened much later in the same tab
 * measures from its own opening value.
 */
export const DEPOSIT_BASELINE_TTL_MS = 60 * 60 * 1000

/**
 * The session storage value for a baseline taken at `now`.
 *
 * @param baseline - Account funds, in base units.
 * @param now - Unix time in milliseconds.
 */
export function writeDepositBaseline(baseline: bigint, now: number) {
  return JSON.stringify({ baseline: baseline.toString(), savedAt: now })
}

/**
 * A stored baseline that is still in date.
 *
 * @param stored - Session storage value, or `null`.
 * @param now - Unix time in milliseconds.
 * @returns The baseline, or `null` when absent, malformed or expired.
 */
export function readDepositBaseline(stored: string | null, now: number) {
  if (stored === null) return null
  try {
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { baseline, savedAt } = parsed as Record<string, unknown>
    if (typeof baseline !== 'string' || !/^-?\d+$/.test(baseline)) return null
    if (
      typeof savedAt !== 'number' ||
      savedAt > now ||
      now - savedAt > DEPOSIT_BASELINE_TTL_MS
    ) {
      return null
    }
    return BigInt(baseline)
  } catch {
    return null
  }
}

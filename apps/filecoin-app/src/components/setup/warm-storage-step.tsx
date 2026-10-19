import { useOperatorApprovals } from '@filoz/synapse-react'
import { ShieldCheckIcon } from 'lucide-react'
import { maxUint256 } from 'viem'
import { AmountForm } from '@/components/amount-form'
import { useDashboard } from '@/components/dashboard-context'
import { txToasts } from '@/components/tx-toast'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useFund, useSetOperatorApproval } from '@/hooks-synapse'
import { EPOCHS_PER_DAY, formatUnitsDisplay } from '@/lib/format'
import {
  type ApprovalState,
  approvalState,
  depositPrefill,
  limitShortfalls,
  type OperatorApprovalTerms,
  REQUIRED_MAX_LOCKUP_PERIOD,
  SETUP_POLL_MS,
  type Shortfall,
  shortfallLabel,
  unlimitedApprovalTerms,
} from '@/lib/setup-status'
import { cn } from '@/lib/utils'
import { SetupStep, type StepTone } from './setup-step'

/** The account's Warm Storage approval, as the setup steps read it. */
export interface WarmStorageApproval {
  state: ApprovalState
  /** The approval's terms; `null` until read. */
  terms: OperatorApprovalTerms | null
  /** Read the approval again, for a first read that failed. */
  retry: () => void
}

/**
 * The account's Warm Storage approval, polled so an approval made in another
 * tab or by the tool shows up. With `unlimitedRequired`, an approval with
 * spending limits reads as `limited`.
 *
 * @param unlimitedRequired - Whether the request asks for `approval=unlimited`.
 */
export function useWarmStorageApproval(
  unlimitedRequired: boolean
): WarmStorageApproval {
  const { address } = useDashboard()
  const { data, isPending, refetch } = useOperatorApprovals({
    address,
    query: { refetchInterval: SETUP_POLL_MS },
  })
  const retry = () => void refetch()
  if (isPending) return { state: 'loading', terms: null, retry }
  // A failed refetch keeps the last answer: dropping it could offer an approval over the owner's limits.
  if (!data) return { state: 'unreadable', terms: null, retry }
  return { state: approvalState(data, unlimitedRequired), terms: data, retry }
}

/** Status label for each {@link ApprovalState}. */
const APPROVAL_STATUS: Record<
  ApprovalState,
  { tone: StepTone; label: string }
> = {
  loading: { tone: 'waiting', label: 'Checking' },
  unreadable: { tone: 'problem', label: 'Could not read the approval' },
  approved: { tone: 'done', label: 'Approved' },
  'not-approved': { tone: 'todo', label: 'Not approved' },
  limited: { tone: 'problem', label: 'Approved with limits' },
}

/**
 * An allowance as the limits table shows it.
 *
 * @param value - Allowance in base units.
 * @param suffix - Unit suffix.
 */
function formatAllowance(value: bigint, suffix = '') {
  return value >= maxUint256 / 2n
    ? 'Unlimited'
    : `${formatUnitsDisplay(value)} USDFC${suffix}`
}

/**
 * A lockup period in whole days.
 *
 * @param epochs - Period in epochs.
 */
function formatPeriod(epochs: bigint) {
  if (epochs >= maxUint256 / 2n) return 'Unlimited'
  const days = epochs / BigInt(EPOCHS_PER_DAY)
  return days === 1n ? '1 day' : `${days} days`
}

/**
 * The owner's current limits beside what the tool needs, so the change is
 * visible before the wallet asks.
 *
 * @param props.terms - The current approval.
 */
function LimitsTable(props: { terms: OperatorApprovalTerms }) {
  const short = limitShortfalls(props.terms)
  const rows = [
    {
      label: 'Rate',
      yours: formatAllowance(props.terms.rateAllowance, ' per epoch'),
      needed: 'Unlimited',
      short: short.rate,
    },
    {
      label: 'Lockup',
      yours: formatAllowance(props.terms.lockupAllowance),
      needed: 'Unlimited',
      short: short.lockup,
    },
    {
      label: 'Lockup period',
      yours: formatPeriod(props.terms.maxLockupPeriod),
      needed: `At least ${formatPeriod(REQUIRED_MAX_LOCKUP_PERIOD)}`,
      short: short.period,
    },
  ]
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1.5 pr-4 font-normal">Limit</th>
          <th className="py-1.5 pr-4 font-normal">Yours</th>
          <th className="py-1.5 font-normal">Needed</th>
        </tr>
      </thead>
      <tbody className="divide-y border-t">
        {rows.map((row) => (
          <tr key={row.label}>
            <td className="py-1.5 pr-4">{row.label}</td>
            <td
              className={cn(
                'py-1.5 pr-4',
                row.short && 'font-medium text-amber-700 dark:text-warning'
              )}
            >
              {row.yours}
              {/* The colour alone would not reach a screen reader. */}
              {row.short ? <span className="sr-only"> (too low)</span> : null}
            </td>
            <td className="py-1.5">{row.needed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Confirm lifting the owner's Warm Storage limits: the one change the setup
 * page makes to an approval that already exists, offered only when the
 * request asks for an unlimited approval.
 *
 * @param props.terms - The current approval.
 */
function RemoveLimits(props: { terms: OperatorApprovalTerms }) {
  const { network } = useDashboard()
  const approve = useSetOperatorApproval(
    txToasts(network, 'Remove spending limits')
  )
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            className="self-start"
            disabled={approve.isPending}
            size="sm"
          />
        }
      >
        {approve.isPending ? <Spinner /> : <ShieldCheckIcon />}
        Remove spending limits
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove Warm Storage spending limits?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Warm Storage will be able to charge for storage without a cap on its
            rate or lockup. It still only charges for data sets you or your
            session keys create, and you can set limits again on the Approvals
            page. The tool that sent this link needs this before it can upload.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              approve.mutate({
                approve: true,
                ...unlimitedApprovalTerms(props.terms),
              })
            }
          >
            Remove limits
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * What the step says it does.
 *
 * @param state - {@link ApprovalState}
 * @param deposit - What the approval also deposits, or `null`.
 */
function describe(state: ApprovalState, deposit: Shortfall | null) {
  if (state === 'limited') {
    return 'The tool needs Warm Storage approved without spending limits before it can upload. Yours has limits.'
  }
  if (deposit) {
    return `One transaction approves Warm Storage to charge for your data sets and deposits ${shortfallLabel(deposit)} from your wallet into Filecoin Pay to pay for them.`
  }
  return 'Lets Warm Storage open payment rails for your data sets and charge for storage.'
}

/**
 * Approve Warm Storage (FWSS) as a Filecoin Pay operator without spending
 * limits, which every upload needs. While the funds step also needs a deposit
 * the wallet can cover, one transaction does both. An existing approval is
 * never replaced, except by the confirmed Remove spending limits step.
 *
 * @param props.number - Step number.
 * @param props.approval - {@link WarmStorageApproval}
 * @param props.deposit - What the approval also deposits, or `null` to approve alone.
 * @param props.walletUsdfc - Wallet USDFC balance, in base units, if read.
 */
export function WarmStorageStep(props: {
  number: number
  approval: WarmStorageApproval
  deposit: Shortfall | null
  walletUsdfc: bigint | undefined
}) {
  const { network } = useDashboard()
  const { approval, deposit } = props
  const fund = useFund(
    txToasts(network, deposit ? 'Approve and deposit' : 'Approval')
  )
  return (
    <SetupStep
      description={describe(approval.state, deposit)}
      number={props.number}
      status={APPROVAL_STATUS[approval.state]}
      title="Approve Warm Storage"
    >
      {approval.state === 'limited' && approval.terms ? (
        <div className="flex flex-col gap-4">
          <LimitsTable terms={approval.terms} />
          <RemoveLimits terms={approval.terms} />
        </div>
      ) : null}
      {approval.state === 'unreadable' ? (
        <Button onClick={approval.retry} size="sm" variant="ghost">
          Could not read the approval. Retry
        </Button>
      ) : null}
      {approval.state === 'not-approved' && deposit ? (
        <AmountForm
          action="Approve and deposit"
          // Restart the form when the amount the request still lacks changes.
          defaultValue={depositPrefill(deposit)}
          description={
            props.walletUsdfc === undefined
              ? undefined
              : `Wallet balance: ${formatUnitsDisplay(props.walletUsdfc)} USDFC`
          }
          key={depositPrefill(deposit)}
          label="Deposit"
          max={props.walletUsdfc}
          onSubmit={(amount) =>
            fund.mutateAsync({ amount, needsFwssMaxApproval: true })
          }
          symbol="USDFC"
        />
      ) : null}
      {approval.state === 'not-approved' && !deposit ? (
        <Button
          disabled={fund.isPending}
          onClick={() =>
            fund.mutate({ amount: 0n, needsFwssMaxApproval: true })
          }
          size="sm"
        >
          {fund.isPending ? <Spinner /> : <ShieldCheckIcon />}
          Approve Warm Storage
        </Button>
      ) : null}
    </SetupStep>
  )
}

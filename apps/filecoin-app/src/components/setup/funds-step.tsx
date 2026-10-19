import { useERC20Balance } from '@filoz/synapse-react'
import { Link } from '@tanstack/react-router'
import { WalletIcon } from 'lucide-react'
import { AmountForm } from '@/components/amount-form'
import { useDashboard } from '@/components/dashboard-context'
import { txToasts } from '@/components/tx-toast'
import { Button } from '@/components/ui/button'
import { useAccountSummary, useDepositWithPermit } from '@/hooks-synapse'
import { formatUnitsDisplay } from '@/lib/format'
import {
  depositPrefill,
  type FundsOffer,
  type Read,
  SETUP_POLL_MS,
  type Shortfall,
  shortfallLabel,
} from '@/lib/setup-status'
import { SetupStep, type StepTone } from './setup-step'

/** The account's Filecoin Pay balance, as the setup steps read it. */
export type AvailableFunds = Read<{
  /** Funds available at the current epoch. */
  available: bigint
  /** Owed beyond the account's funds; `available` is 0 while there is any. */
  debt: bigint
  /** The account's funds, deposits and all, before lockup. */
  funds: bigint
}>

/** The wallet's own USDFC, as the setup steps read it. */
export type WalletUsdfc = Read<{ balance: bigint }>

/**
 * The account's USDFC in Filecoin Pay and in the wallet, read from the chain
 * and polled, so a deposit counts as soon as its receipt lands, even one made
 * in another tab or by the tool.
 *
 * @param enabled - Whether the request asks for funds at all.
 */
export function useSetupFunds(enabled: boolean): {
  funds: AvailableFunds
  wallet: WalletUsdfc
} {
  const { address } = useDashboard()
  const summary = useAccountSummary({
    address,
    query: { enabled, refetchInterval: SETUP_POLL_MS },
  })
  const usdfc = useERC20Balance({
    address,
    query: { enabled, refetchInterval: SETUP_POLL_MS },
  })
  // A failed refetch keeps the last answer; only a read that never answered is unreadable.
  const wallet: WalletUsdfc = usdfc.data
    ? { state: 'ready', balance: usdfc.data.value }
    : usdfc.isPending
      ? { state: 'loading' }
      : { state: 'unreadable' }
  const funds: AvailableFunds = summary.data
    ? {
        state: 'ready',
        available: summary.data.availableFunds,
        debt: summary.data.debt,
        funds: summary.data.funds,
      }
    : summary.isPending
      ? { state: 'loading' }
      : { state: 'unreadable' }
  return { funds, wallet }
}

/**
 * Status label for the Pay balance.
 *
 * @param funds - {@link AvailableFunds}
 * @param done - Whether the request's funds are covered.
 */
function balanceStatus(
  funds: AvailableFunds,
  done: boolean
): { tone: StepTone; label: string } {
  if (funds.state === 'loading') return { tone: 'waiting', label: 'Checking' }
  if (funds.state === 'unreadable') {
    return { tone: 'problem', label: 'Could not read your balance' }
  }
  return {
    tone: done ? 'done' : 'todo',
    label: `${formatUnitsDisplay(funds.available)} USDFC available`,
  }
}

/**
 * Fund Filecoin Pay with what the request still lacks: a permit deposit from
 * the wallet when it holds enough, a note that the approval step deposits it
 * when that step still has to run, or a pointer to get USDFC first.
 *
 * @param props.number - Step number.
 * @param props.deposit - The decimal deposit the request names, or `null`.
 * @param props.funds - {@link AvailableFunds}
 * @param props.wallet - {@link WalletUsdfc}
 * @param props.missing - {@link Shortfall}, or `null` while it is unknown.
 * @param props.offer - {@link FundsOffer}
 */
export function FundsStep(props: {
  number: number
  deposit: string | null
  funds: AvailableFunds
  wallet: WalletUsdfc
  missing: Shortfall | null
  offer: FundsOffer
}) {
  const { network } = useDashboard()
  const deposit = useDepositWithPermit(txToasts(network, 'Deposit'))
  const { missing, offer, wallet } = props
  const label = missing ? shortfallLabel(missing) : 'USDFC'
  const walletBalance = wallet.state === 'ready' ? wallet.balance : undefined

  return (
    <SetupStep
      description={
        props.deposit
          ? `The tool needs ${props.deposit} USDFC more in Filecoin Pay. Storage is paid from that balance.`
          : 'Storage is paid from your Filecoin Pay balance, so the tool needs some there to upload.'
      }
      number={props.number}
      status={balanceStatus(props.funds, offer === 'done')}
      title="Fund Filecoin Pay"
    >
      {offer === 'with-approval' ? (
        <p className="text-sm text-muted-foreground">
          Approving Warm Storage above also deposits the {label} from your
          wallet, in the same transaction.
        </p>
      ) : null}
      {offer === 'get-usdfc' ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            {wallet.state === 'ready'
              ? `Your wallet holds ${formatUnitsDisplay(wallet.balance)} USDFC, less than the ${label} still missing.`
              : 'Your wallet balance could not be read.'}{' '}
            Add USDFC to this wallet, then deposit it here.
          </p>
          <Button
            nativeButton={false}
            render={<Link to="/dashboard/account" />}
            size="sm"
            variant="outline"
          >
            <WalletIcon />
            Open Pay account
          </Button>
        </div>
      ) : null}
      {offer === 'deposit' && missing ? (
        <AmountForm
          action="Deposit"
          defaultValue={depositPrefill(missing)}
          description={
            walletBalance === undefined
              ? undefined
              : `Wallet balance: ${formatUnitsDisplay(walletBalance)} USDFC`
          }
          // Restart the form when the amount the request still lacks changes.
          key={depositPrefill(missing)}
          label="Amount"
          max={walletBalance}
          onSubmit={(amount) => deposit.mutateAsync({ amount })}
          symbol="USDFC"
        />
      ) : null}
    </SetupStep>
  )
}

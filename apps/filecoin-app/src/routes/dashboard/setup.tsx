import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowLeftRightIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatUnits } from 'viem'
import { useSwitchChain } from 'wagmi'
import { useDashboard } from '@/components/dashboard-context'
import { NetworkDot } from '@/components/network-switcher'
import { PageHeader } from '@/components/page-header'
import {
  type AvailableFunds,
  FundsStep,
  useSetupFunds,
} from '@/components/setup/funds-step'
import {
  SessionKeyStep,
  useKeyGrant,
} from '@/components/setup/session-key-step'
import {
  useWarmStorageApproval,
  WarmStorageStep,
} from '@/components/setup/warm-storage-step'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SETUP_STATUS_DESCRIPTION } from '@/components/webmcp-tools'
import { useWebMcpTool } from '@/hooks/use-webmcp-tool'
import { shortHex } from '@/lib/format'
import { CHAINS, NETWORK_LABELS, type Network } from '@/lib/networks'
import {
  parseSetupLink,
  SETUP_LINK_ERRORS,
  type SetupRequest,
  setupSearchSchema,
} from '@/lib/setup-request'
import {
  fundsOffer,
  isSetupComplete,
  readDepositBaseline,
  type Shortfall,
  shortfall,
  writeDepositBaseline,
} from '@/lib/setup-status'

export const Route = createFileRoute('/dashboard/setup')({
  validateSearch: setupSearchSchema,
  component: SetupPage,
})

/** USDFC base units as a decimal string, for tool results. */
const usdfc = (value: bigint) => formatUnits(value, 18)

/**
 * Ask the user to switch the wallet to the network the request is for.
 *
 * @param props.network - Requested network.
 */
function SwitchNetwork(props: { network: Network }) {
  const { network } = useDashboard()
  const { mutate: switchChain, isPending } = useSwitchChain()
  return (
    <Alert>
      <ArrowLeftRightIcon />
      <AlertTitle>
        This request is for {NETWORK_LABELS[props.network]}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        Your wallet is on {NETWORK_LABELS[network]}. Nothing here applies until
        you switch: approving on the wrong network would set up a different
        account.
        <Button
          disabled={isPending}
          onClick={() => switchChain({ chainId: CHAINS[props.network].id })}
          size="sm"
        >
          {isPending ? <Spinner /> : <NetworkDot network={props.network} />}
          Switch to {NETWORK_LABELS[props.network]}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/**
 * `get_setup_status` while the page offers no steps: the link cannot be
 * used, or the wallet is on the other network.
 *
 * @param props.status - What the tool reports.
 */
function BlockedStatusTool(props: { status: Record<string, unknown> }) {
  const { address, network } = useDashboard()
  useWebMcpTool({
    name: 'get_setup_status',
    description: SETUP_STATUS_DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
    execute: () => ({
      walletConnected: true,
      wallet: address,
      network,
      complete: false,
      ...props.status,
    }),
    annotations: { readOnlyHint: true },
  })
  return null
}

/**
 * For a request with a deposit but no balance: the account's funds when this
 * tab first opened it, so the funds step can tell the deposit went in. Kept
 * in session storage, so a reload in this tab keeps it, and scoped to the
 * link's key and amount so a later request is not counted as done by an
 * earlier deposit. `null` until known, or when the request needs none.
 *
 * @param request - The setup request.
 * @param funds - {@link AvailableFunds}
 */
function useDepositBaseline(request: SetupRequest, funds: AvailableFunds) {
  const { address, network } = useDashboard()
  const wanted =
    request.deposit !== null &&
    request.balance === null &&
    funds.state === 'ready'
  const key = [
    'filecoin-app-setup-deposit-baseline',
    network,
    address.toLowerCase(),
    request.sessionKey?.address ?? 'no-key',
    request.deposit,
  ].join(':')
  const current = funds.state === 'ready' ? funds.funds : null
  const [baseline, setBaseline] = useState<bigint | null>(null)
  useEffect(() => {
    if (!wanted || baseline !== null || current === null) return
    let stored: string | null = null
    try {
      stored = window.sessionStorage.getItem(key)
    } catch {
      // Storage can be blocked; the baseline then lasts until this page closes.
    }
    const kept = readDepositBaseline(stored, Date.now())
    if (kept !== null) {
      setBaseline(kept)
      return
    }
    try {
      window.sessionStorage.setItem(
        key,
        writeDepositBaseline(current, Date.now())
      )
    } catch {
      // As above.
    }
    setBaseline(current)
  }, [wanted, baseline, current, key])
  return wanted ? baseline : null
}

/**
 * The steps a request needs, in a fixed order (key, approval, funds), each
 * with its live status from the chain. Only what each step offers changes as
 * the reads come in.
 *
 * @param props.request - The setup request.
 */
function SetupSteps(props: { request: SetupRequest }) {
  const { address, network } = useDashboard()
  const { request } = props
  const { grant, expirations } = useKeyGrant(request.sessionKey)
  const approval = useWarmStorageApproval(request.unlimitedApproval)
  // An approval-only request never shows funds, so it reads none.
  const { funds, wallet } = useSetupFunds(!request.approvalOnly)
  const baseline = useDepositBaseline(request, funds)
  // A deposit is measured from the baseline, so nothing is offered until it is known:
  // a deposit sent before the first read would otherwise be asked for again.
  const awaitingBaseline =
    request.deposit !== null && request.balance === null && baseline === null
  const liveMissing =
    funds.state === 'loading' || awaitingBaseline
      ? null
      : shortfall({
          // An unreadable balance counts as empty, so the steps offered still work.
          available: funds.state === 'ready' ? funds.available : 0n,
          debt: funds.state === 'ready' ? funds.debt : 0n,
          funds: funds.state === 'ready' ? funds.funds : 0n,
          baseline,
          deposit: request.deposit,
          balance: request.balance,
        })
  // Once Filecoin Pay holds what the request asks for, the funds stay counted for this
  // visit: lockup keeps drawing the balance down, and a step that reopened a cent short
  // would take back "Setup complete" while the tool carries on. A reload checks again.
  const [fundsReached, setFundsReached] = useState(false)
  useEffect(() => {
    if (funds.state === 'ready' && liveMissing?.kind === 'none') {
      setFundsReached(true)
    }
  }, [funds.state, liveMissing?.kind])
  const missing: Shortfall | null = fundsReached
    ? { kind: 'none' }
    : liveMissing
  const offer = fundsOffer({
    missing,
    walletUsdfc: wallet,
    approval: approval.state,
  })
  const complete = isSetupComplete({
    keyRequested: request.sessionKey !== null,
    grant,
    approved: approval.state === 'approved',
    fundsCovered: request.approvalOnly || missing?.kind === 'none',
  })
  const first = request.sessionKey ? 2 : 1

  useWebMcpTool({
    name: 'get_setup_status',
    description: SETUP_STATUS_DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
    execute: () => ({
      walletConnected: true,
      wallet: address,
      network,
      requestedNetwork: request.network ?? network,
      wrongNetwork: false,
      complete,
      sessionKey: request.sessionKey
        ? {
            signer: request.sessionKey.address,
            requestedScopes: request.sessionKey.scopes,
            state: grant.state,
            grantedScopes:
              grant.state === 'authorized'
                ? request.sessionKey.scopes
                : grant.state === 'partial'
                  ? grant.granted
                  : [],
            authorized: grant.state === 'authorized',
            expiresAt:
              grant.state === 'authorized'
                ? new Date(Number(grant.expiresAt) * 1000).toISOString()
                : null,
          }
        : null,
      warmStorage: {
        state: approval.state,
        unlimitedRequired: request.unlimitedApproval,
      },
      warmStorageApproved: approval.state === 'approved',
      funds: request.approvalOnly
        ? null
        : {
            availableFunds:
              funds.state === 'ready' ? usdfc(funds.available) : null,
            debt: funds.state === 'ready' ? usdfc(funds.debt) : null,
            walletUsdfc:
              wallet.state === 'ready' ? usdfc(wallet.balance) : null,
            requestedDeposit: request.deposit,
            requestedBalance: request.balance,
            missing:
              missing === null
                ? null
                : missing.kind === 'amount'
                  ? usdfc(missing.amount)
                  : missing.kind,
            offer,
          },
      nextStep: complete
        ? 'Setup is complete. The tool that sent the link can carry on.'
        : 'The user approves each step on this page in their wallet. Agents cannot sign for them.',
    }),
    annotations: { readOnlyHint: true },
  })

  return (
    <>
      <ol className="flex flex-col">
        {request.sessionKey ? (
          <SessionKeyStep
            expiries={expirations.data}
            grant={grant}
            number={1}
            request={request.sessionKey}
          />
        ) : null}
        <WarmStorageStep
          approval={approval}
          // An approval-only request never deposits.
          deposit={
            !request.approvalOnly && offer === 'with-approval' ? missing : null
          }
          number={first}
          walletUsdfc={wallet.state === 'ready' ? wallet.balance : undefined}
        />
        {request.approvalOnly ? null : (
          <FundsStep
            deposit={request.deposit}
            funds={funds}
            missing={missing}
            number={first + 1}
            offer={offer}
            wallet={wallet}
          />
        )}
      </ol>
      {/* Mounted empty so screen readers announce the moment it fills. */}
      <div aria-live="polite">
        {complete ? (
          <Alert className="border-success/40 bg-success/5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
            <CircleCheckIcon className="text-green-700 dark:text-success" />
            <AlertTitle>Setup complete</AlertTitle>
            <AlertDescription>
              Go back to the tool that sent this link. A command that is still
              waiting carries on by itself; otherwise run it again.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </>
  )
}

/**
 * Review page for a setup request from a link or an agent: authorize a
 * session key, approve Warm Storage, and fund Filecoin Pay. Each step is its
 * own wallet transaction and shows its live status from the chain, so
 * reloading the link only shows what is already done.
 */
function SetupPage() {
  const { address, network } = useDashboard()
  const search = Route.useSearch()
  const request = useMemo(() => parseSetupLink(search), [search])
  const requested = 'error' in request ? network : (request.network ?? network)

  return (
    <>
      <PageHeader
        description={`A tool or agent asked to set up ${shortHex(address)} on ${NETWORK_LABELS[requested]}. Each step is its own wallet transaction, and you can change what it asked for before you approve.`}
        title="Review setup request"
      />
      {'error' in request ? (
        <>
          <BlockedStatusTool
            status={{
              linkError: SETUP_LINK_ERRORS[request.error],
              nextStep:
                'The setup link cannot be used. Ask the tool that made it for a new link, or call prepare_setup_request.',
            }}
          />
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>This setup link cannot be used</AlertTitle>
            <AlertDescription>
              {SETUP_LINK_ERRORS[request.error]} Nothing was changed. Ask the
              tool that sent it for a new link.
            </AlertDescription>
          </Alert>
        </>
      ) : requested === network ? (
        <>
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>Only approve requests you started</AlertTitle>
            <AlertDescription>
              Authorize a session key only if you created it yourself, with a
              tool on your own machine. This page cannot tell who sent the link.
            </AlertDescription>
          </Alert>
          <SetupSteps
            // A new link or wallet must not keep the previous one's baseline or reached funds.
            key={`${network}:${address}:${JSON.stringify(search)}`}
            request={request}
          />
        </>
      ) : (
        <>
          <BlockedStatusTool
            status={{
              requestedNetwork: requested,
              wrongNetwork: true,
              nextStep: `Ask the user to switch their wallet to ${NETWORK_LABELS[requested]} on this page.`,
            }}
          />
          <SwitchNetwork network={requested} />
        </>
      )}
    </>
  )
}

import type { Expirations } from '@filoz/synapse-core/session-key'
import { ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { CopyButton } from '@/components/copy-button'
import { useDashboard } from '@/components/dashboard-context'
import { txToasts } from '@/components/tx-toast'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useSessionKeyExpirations, useSessionKeyLogin } from '@/hooks-synapse'
import { formatTimestamp } from '@/lib/format'
import { permissionLabel } from '@/lib/permissions'
import {
  DEFAULT_DAYS,
  DEFAULT_NAME,
  expiryFromDays,
  isValidDays,
  MAX_DAYS,
  MAX_NAME_LENGTH,
  SCOPE_IDS,
  SCOPE_PERMISSIONS,
  type ScopeId,
  type SessionKeyRequest,
} from '@/lib/setup-request'
import {
  AUTHORIZED_POLL_MS,
  type KeyGrant,
  keyGrant,
  SETUP_POLL_MS,
} from '@/lib/setup-status'
import { SetupStep, type StepTone } from './setup-step'

/** What each scope lets a session key do, shown under its checkbox. */
const SCOPE_HELP: Record<ScopeId, string> = {
  createDataSet: 'Create data sets paid by your wallet.',
  addPieces: 'Add pieces to your data sets.',
  schedulePieceRemovals: 'Remove pieces from your data sets.',
  terminateService:
    'End the storage service of your data sets. Few tools need this.',
}

/** Current Unix time in seconds. */
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000))

/**
 * The registry's live answer for each scope the request names, polled so a
 * grant sent from elsewhere shows up too. The wallet's own address is never
 * read: it can never be its own session key.
 *
 * @param request - The requested session key, or `null`.
 */
export function useKeyGrant(request: SessionKeyRequest | null): {
  grant: KeyGrant
  expirations: ReturnType<typeof useSessionKeyExpirations>
} {
  const { address } = useDashboard()
  const isSelf = request !== null && isAddressEqual(request.address, address)
  const scopes = request?.scopes ?? []
  const expirations = useSessionKeyExpirations({
    address,
    sessionKeyAddress: request && !isSelf ? request.address : undefined,
    query: {
      refetchInterval: (query) =>
        keyGrant(scopes, query.state.data, nowSeconds()).state === 'authorized'
          ? AUTHORIZED_POLL_MS
          : SETUP_POLL_MS,
    },
  })
  if (!request || isSelf) return { grant: { state: 'none' }, expirations }
  // A failed refetch keeps the last answer; only a read that never answered is unreadable.
  if (expirations.data === undefined && expirations.isError) {
    return { grant: { state: 'unreadable' }, expirations }
  }
  return {
    grant: keyGrant(request.scopes, expirations.data, nowSeconds()),
    expirations,
  }
}

/**
 * Status label for a {@link KeyGrant}.
 *
 * @param grant - {@link KeyGrant}
 */
function grantStatus(grant: KeyGrant): { tone: StepTone; label: string } {
  switch (grant.state) {
    case 'loading':
      return { tone: 'waiting', label: 'Checking' }
    case 'unreadable':
      return { tone: 'problem', label: 'Could not read its status' }
    case 'none':
      return { tone: 'todo', label: 'Not authorized' }
    case 'partial':
      return { tone: 'problem', label: 'Partly authorized' }
    case 'authorized':
      return {
        tone: 'done',
        label: `Authorized until ${formatTimestamp(grant.expiresAt)}`,
      }
  }
}

/**
 * One row of the key summary.
 *
 * @param props.term - Row label.
 * @param props.children - Row value.
 */
function Detail(props: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[7rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{props.term}</dt>
      <dd className="min-w-0">{props.children}</dd>
    </div>
  )
}

/**
 * Review and authorize the session key the request names. The form starts
 * from the link's name, scopes and days, and the owner can change the name
 * and expiry or drop scopes, but never grant a scope the link did not ask
 * for. Once every scope is live, the step shows the grant instead.
 *
 * @param props.number - Step number.
 * @param props.request - The requested session key.
 * @param props.grant - {@link KeyGrant} from {@link useKeyGrant}.
 * @param props.expiries - Live expiry of each permission, from {@link useKeyGrant}.
 */
export function SessionKeyStep(props: {
  number: number
  request: SessionKeyRequest
  grant: KeyGrant
  expiries: Partial<Expirations> | undefined
}) {
  const { address, network } = useDashboard()
  const { request, grant, expiries } = props
  const [name, setName] = useState(request.name ?? DEFAULT_NAME)
  const [scopes, setScopes] = useState<ScopeId[]>(request.scopes)
  const [days, setDays] = useState(String(request.days ?? DEFAULT_DAYS))
  const login = useSessionKeyLogin(txToasts(network, 'Authorize session key'))
  const isSelf = isAddressEqual(request.address, address)
  const now = nowSeconds()
  const validName = name.trim().length > 0 && name.length <= MAX_NAME_LENGTH
  const canSubmit =
    !isSelf &&
    validName &&
    isValidDays(days) &&
    scopes.length > 0 &&
    !login.isPending

  return (
    <SetupStep
      description="Lets the tool sign storage actions for this wallet until it expires. It can never move your funds, and you can revoke it from Session keys."
      number={props.number}
      status={grantStatus(grant)}
      title="Authorize a session key"
    >
      <FieldGroup>
        <dl className="divide-y rounded-lg border px-4 text-sm">
          <Detail term="Key">
            <span className="flex items-start gap-1 font-mono text-xs break-all">
              {request.address}
              <CopyButton value={request.address} />
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Check that it matches the address your tool printed.
            </span>
          </Detail>
          {grant.state === 'authorized' ? (
            <Detail term="Permissions">
              <ul className="flex flex-col gap-0.5">
                {request.scopes.map((scope) => (
                  <li key={scope}>
                    {permissionLabel(SCOPE_PERMISSIONS[scope])}
                  </li>
                ))}
              </ul>
            </Detail>
          ) : null}
        </dl>
        {isSelf ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>This is your wallet address</AlertTitle>
            <AlertDescription>
              A session key must be a separate address. Ask the tool for a new
              key.
            </AlertDescription>
          </Alert>
        ) : grant.state === 'authorized' ? null : (
          <>
            <Field>
              <FieldLabel htmlFor="setup-name">Name</FieldLabel>
              <Input
                aria-invalid={!validName}
                id="setup-name"
                maxLength={MAX_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <FieldDescription>
                Recorded on chain with the authorization, so you can recognise
                the key later.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Permissions</FieldLabel>
              <div className="flex flex-col gap-3">
                {SCOPE_IDS.map((scope) => {
                  const expiry = expiries?.[SCOPE_PERMISSIONS[scope]] ?? 0n
                  const requested = request.scopes.includes(scope)
                  return (
                    <Field key={scope} orientation="horizontal">
                      <Checkbox
                        checked={scopes.includes(scope)}
                        // Reduce-only: the owner never grants more than the link asked for.
                        disabled={!requested}
                        id={`setup-scope-${scope}`}
                        onCheckedChange={(checked) =>
                          setScopes((prev) =>
                            SCOPE_IDS.filter((id) =>
                              id === scope ? checked : prev.includes(id)
                            )
                          )
                        }
                      />
                      <div className="flex flex-col gap-0.5">
                        <FieldLabel htmlFor={`setup-scope-${scope}`}>
                          {permissionLabel(SCOPE_PERMISSIONS[scope])}
                          {expiry > now ? (
                            <span className="text-xs font-normal text-green-700 dark:text-success">
                              until {formatTimestamp(expiry)}
                            </span>
                          ) : null}
                        </FieldLabel>
                        <FieldDescription>
                          {requested
                            ? SCOPE_HELP[scope]
                            : 'Not requested by this link.'}
                        </FieldDescription>
                      </div>
                    </Field>
                  )
                })}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-days">Expires in (days)</FieldLabel>
              <Input
                aria-invalid={!isValidDays(days)}
                id="setup-days"
                inputMode="numeric"
                onChange={(event) => setDays(event.target.value)}
                value={days}
              />
              <FieldDescription>From 1 to {MAX_DAYS} days.</FieldDescription>
            </Field>
            <Button
              className="self-start"
              disabled={!canSubmit || grant.state === 'loading'}
              onClick={() =>
                login.mutate({
                  address: request.address as Address,
                  permissions: scopes.map((scope) => SCOPE_PERMISSIONS[scope]),
                  expiresAt: expiryFromDays(Number(days)),
                  origin: name.trim(),
                })
              }
            >
              {login.isPending ? <Spinner /> : <ShieldCheckIcon />}
              {grant.state === 'partial' ? 'Authorize again' : 'Authorize'}
            </Button>
          </>
        )}
      </FieldGroup>
    </SetupStep>
  )
}

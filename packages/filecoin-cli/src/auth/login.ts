import { setTimeout as sleep } from 'node:timers/promises'
import { sessionKeyRegistry } from '@filoz/synapse-core/abis'
import type { FilecoinChain } from '@filoz/synapse-core/chains'
import {
  type Expirations,
  getExpirations,
} from '@filoz/synapse-core/session-key'
import {
  type Address,
  type Client,
  getAbiItem,
  isAddressEqual,
  type Transport,
} from 'viem'
import { getBlockNumber, getLogs } from 'viem/actions'
import type { Network } from '../network.ts'
import { APPLICATION_SOURCE } from '../source.ts'
import { formatUsdfc } from '../usdfc.ts'
import { SCOPES, type ScopeId, toPermissions } from './scopes.ts'

/** Read client for the target chain. */
type ChainClient = Client<Transport, FilecoinChain>

/**
 * Filecoin Pay console page that reviews a CLI's request: a session key, the
 * Warm Storage approval, and a deposit, each as its own step.
 */
const SETUP_PATH = '/console/setup'

/** Filecoin Pay console page that lists and revokes session keys. */
const SESSION_KEYS_PATH = '/console/session-keys'

/**
 * Filecoin Pay console home: the connected wallet's funds, services, and
 * approvals. It follows the wallet's network, so its link has no `network`.
 */
const CONSOLE_PATH = '/console'

/**
 * Who runs the CLI, for the console's link analytics. Without tags, as when
 * the user opts out, a link carries no `utm_*` parameters.
 */
export type LinkTags = {
  /** An agent name, `human`, or `automation`; sent as `utm_content`. */
  driver?: string | undefined
}

/** The flow that printed a console link, sent as `utm_term`. */
type LinkFlow = 'login' | 'fund' | 'revoke' | 'console'

/**
 * Add the console's analytics tags to `url`: `utm_source=filecoin-cli`,
 * `utm_medium=cli`, the flow as `utm_term`, and the driver as `utm_content`.
 * The values match filecoin-pin's, so the console can compare the two CLIs.
 * `utm_campaign` is left for marketing campaigns.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/master/src/core/session/console-url.ts
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/funnel-analytics.ts
 */
function tagged(url: URL, tags: LinkTags | undefined, flow: LinkFlow): string {
  if (tags) {
    url.searchParams.set('utm_source', APPLICATION_SOURCE)
    url.searchParams.set('utm_medium', 'cli')
    url.searchParams.set('utm_term', flow)
    if (tags.driver) url.searchParams.set('utm_content', tags.driver)
  }
  return url.toString()
}

/**
 * Start a setup link that requires the unlimited Warm Storage approval.
 *
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/pay/is-fwss-max-approved.ts
 */
function setupUrl(consoleUrl: string, network: Network): URL {
  const url = new URL(SETUP_PATH, consoleUrl)
  url.searchParams.set('network', network)
  // synapse-core counts Warm Storage as approved only without spending
  // limits; without this, the console accepts any approval.
  url.searchParams.set('approval', 'unlimited')
  return url
}

/** Options for {@link buildAuthorizeUrl}. */
export type AuthorizeUrlOptions = {
  consoleUrl: string
  /** Session key address to authorize. */
  address: Address
  scopes: readonly ScopeId[]
  network: Network
  /** Session-key name, recorded on chain as the authorization's origin. */
  name?: string | undefined
  /** Days until the authorization expires; the console defaults to 30. */
  days?: number | undefined
  /** Analytics tags; leave out for an untagged link. */
  tags?: LinkTags | undefined
}

/**
 * Build the Filecoin Pay console setup link that asks the wallet owner to
 * authorize a session key. The owner reviews the prefilled key, then the Warm
 * Storage approval and funding steps, and signs each with their wallet. The
 * address is lowercased because the console rejects an invalid mixed-case
 * checksum and accepts all-lowercase input.
 *
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = setupUrl(options.consoleUrl, options.network)
  url.searchParams.set('authorize', options.address.toLowerCase())
  url.searchParams.set('scopes', options.scopes.join(','))
  if (options.name) url.searchParams.set('name', options.name)
  if (options.days != null) url.searchParams.set('days', String(options.days))
  return tagged(url, options.tags, 'login')
}

/** Options for {@link buildRevokeUrl}. */
export type RevokeUrlOptions = {
  consoleUrl: string
  /** Session key address to revoke. */
  address: Address
  network: Network
  /** Analytics tags; leave out for an untagged link. */
  tags?: LinkTags | undefined
}

/**
 * Build the Filecoin Pay console link that asks the wallet owner to revoke a
 * session key on chain.
 *
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/authorizeParam.ts
 */
export function buildRevokeUrl(options: RevokeUrlOptions): string {
  const url = new URL(SESSION_KEYS_PATH, options.consoleUrl)
  url.searchParams.set('revoke', options.address.toLowerCase())
  url.searchParams.set('network', options.network)
  return tagged(url, options.tags, 'revoke')
}

/** Options for {@link buildConsoleUrl}. */
export type ConsoleUrlOptions = {
  consoleUrl: string
  /** Analytics tags; leave out for an untagged link. */
  tags?: LinkTags | undefined
}

/**
 * Build the Filecoin Pay console home link, where the wallet owner manages
 * funds, services, and approvals. filecoin-pin's `dashboard` opens the same
 * page but tags it `utm_term=dashboard`.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/master/src/core/session/console-url.ts
 */
export function buildConsoleUrl(options: ConsoleUrlOptions): string {
  const url = new URL(CONSOLE_PATH, options.consoleUrl)
  return tagged(url, options.tags, 'console')
}

/** Options for {@link buildFundingUrl}. */
export type FundingUrlOptions = {
  consoleUrl: string
  network: Network
  /** USDFC base units to deposit; omit or pass 0 to ask only for the approval. */
  deposit?: bigint
  /**
   * USDFC base units the payer needs available once funded, so the console
   * checks the same target as the CLI. Sent only with a deposit.
   */
  balance?: bigint
  /** Analytics tags; leave out for an untagged link. */
  tags?: LinkTags | undefined
}

/**
 * Build the Filecoin Pay console setup link that asks for the unlimited Warm
 * Storage approval and, when `deposit` is positive, a USDFC deposit. When the
 * wallet holds the USDFC, the console approves and deposits in one
 * transaction. Without a deposit the link asks only for the approval.
 *
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 */
export function buildFundingUrl(options: FundingUrlOptions): string {
  const url = setupUrl(options.consoleUrl, options.network)
  if (options.deposit != null && options.deposit > 0n) {
    url.searchParams.set('deposit', formatUsdfc(options.deposit))
    if (options.balance != null && options.balance > 0n) {
      url.searchParams.set('balance', formatUsdfc(options.balance))
    }
  }
  return tagged(url, options.tags, 'fund')
}

/**
 * The available USDFC an account reaches after depositing `depositNeeded`,
 * sent as the setup link's `balance`. A deposit settles debt first, so the
 * debt comes off the target.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/pay/get-account-summary.ts
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 */
export function targetBalance(account: {
  availableFunds: bigint
  debt: bigint
  depositNeeded: bigint
}): bigint {
  const target = account.availableFunds + account.depositNeeded - account.debt
  return target > 0n ? target : 0n
}

/**
 * Block span of one `eth_getLogs` request, below Glif's limit of 360 blocks
 * per request (`to - from + 1`).
 */
export const LOG_WINDOW = 300n

/** Options for {@link findAuthorizer}. */
export type FindAuthorizerOptions = {
  client: ChainClient
  /** Session key address to look for. */
  signer: Address
  /** First block to scan: the block when the key was created. */
  fromBlock: bigint
}

/**
 * Find the wallet that authorized `signer`. `signer` is not an indexed event
 * field, so this scans the registry's `AuthorizationsUpdated` events from
 * `fromBlock` in bounded windows and matches the signer locally. Returns the
 * most recent authorizing identity, or `undefined`.
 */
export async function findAuthorizer(
  options: FindAuthorizerOptions
): Promise<Address | undefined> {
  const { client, signer } = options
  const event = getAbiItem({
    abi: sessionKeyRegistry,
    name: 'AuthorizationsUpdated',
  })
  const latest = await getBlockNumber(client, { cacheTime: 0 })
  let found: Address | undefined
  for (let from = options.fromBlock; from <= latest; from += LOG_WINDOW + 1n) {
    // biome-ignore lint/complexity/useMathMinMax: Math.min throws on bigint
    const to = from + LOG_WINDOW > latest ? latest : from + LOG_WINDOW
    const logs = await getLogs(client, {
      address: client.chain.contracts.sessionKeyRegistry.address,
      event,
      fromBlock: from,
      toBlock: to,
      strict: true,
    })
    for (const log of logs) {
      if (isAddressEqual(log.args.signer, signer)) {
        found = log.args.identity
      }
    }
  }
  return found
}

/** Per-scope state of a session key read from the registry. */
export type ScopeGrants = {
  granted: ScopeId[]
  missing: ScopeId[]
  /** Earliest expiry among granted scopes, in Unix seconds. */
  expiresAt?: bigint
}

/**
 * Split requested scopes into live and missing using on-chain expiries.
 * `now` is in Unix seconds.
 */
export function classifyScopes(
  scopes: readonly ScopeId[],
  expirations: Partial<Expirations>,
  now = BigInt(Math.floor(Date.now() / 1000))
): ScopeGrants {
  const granted: ScopeId[] = []
  const missing: ScopeId[] = []
  let expiresAt: bigint | undefined
  for (const scope of scopes) {
    const expiry = expirations[SCOPES[scope]] ?? 0n
    if (expiry > now) {
      granted.push(scope)
      if (expiresAt === undefined || expiry < expiresAt) expiresAt = expiry
    } else {
      missing.push(scope)
    }
  }
  return expiresAt === undefined
    ? { granted, missing }
    : { granted, missing, expiresAt }
}

/** Options for {@link readScopes}. */
export type ReadScopesOptions = {
  client: ChainClient
  root: Address
  signer: Address
  scopes: readonly ScopeId[]
}

/** Read the requested scopes' expiries for a session key. */
export async function readScopes(
  options: ReadScopesOptions
): Promise<ScopeGrants> {
  const expirations = await getExpirations(options.client, {
    address: options.root,
    sessionKeyAddress: options.signer,
    permissions: toPermissions(options.scopes),
  })
  return classifyScopes(options.scopes, expirations)
}

/** Result of one {@link checkAuthorization} pass. */
export type AuthorizationState =
  | { status: 'pending' }
  | ({ status: 'granted' | 'partial' | 'none'; root: Address } & ScopeGrants)

/** Options for {@link checkAuthorization}. */
export type CheckAuthorizationOptions = {
  client: ChainClient
  signer: Address
  scopes: readonly ScopeId[]
  fromBlock: bigint
}

/**
 * Check once whether the owner has acted on a pending session key: find the
 * owner, then read the requested scopes.
 */
export async function checkAuthorization(
  options: CheckAuthorizationOptions
): Promise<AuthorizationState> {
  const root = await findAuthorizer(options)
  if (!root) return { status: 'pending' }
  const grants = await readScopes({ ...options, root })
  const status =
    grants.missing.length === 0
      ? 'granted'
      : grants.granted.length > 0
        ? 'partial'
        : 'none'
  return { status, root, ...grants }
}

/** Options for {@link waitForAuthorization}. */
export type WaitForAuthorizationOptions = CheckAuthorizationOptions & {
  timeoutMs: number
  /** Stops waiting; a client bound to it also cancels the pending check. */
  signal?: AbortSignal
}

/** Milliseconds between authorization checks. */
const POLL_INTERVAL = 3000

/**
 * Poll {@link checkAuthorization} until the owner acts or `timeoutMs`
 * passes. RPC errors are retried. Rejects with the signal's reason when
 * `signal` aborts.
 */
export async function waitForAuthorization(
  options: WaitForAuthorizationOptions
): Promise<AuthorizationState> {
  const started = Date.now()
  for (;;) {
    try {
      const state = await checkAuthorization(options)
      if (state.status !== 'pending') return state
    } catch (error) {
      if (options.signal?.aborted) throw error
    }
    if (Date.now() - started + POLL_INTERVAL > options.timeoutMs) {
      return { status: 'pending' }
    }
    await sleep(POLL_INTERVAL, undefined, { signal: options.signal })
  }
}

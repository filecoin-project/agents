import {
  AddPiecesPermission,
  CreateDataSetPermission,
  type Permission,
  SchedulePieceRemovalsPermission,
  TerminateServicePermission,
} from '@filoz/synapse-core/session-key'
import { type Address, isAddress } from 'viem'
import { z } from 'zod'
import { NETWORKS, type Network } from './networks.ts'

/**
 * Session-key scope IDs a setup link can request, in display order. They
 * match the IDs `filecoin login --scopes` takes.
 */
export const SCOPE_IDS = [
  'createDataSet',
  'addPieces',
  'schedulePieceRemovals',
  'terminateService',
] as const

/** A session-key scope ID. */
export type ScopeId = (typeof SCOPE_IDS)[number]

/**
 * FWSS permission typehash for each scope ID.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/docs/src/content/docs/developer-guides/session-keys.mdx
 */
export const SCOPE_PERMISSIONS = {
  createDataSet: CreateDataSetPermission,
  addPieces: AddPiecesPermission,
  schedulePieceRemovals: SchedulePieceRemovalsPermission,
  terminateService: TerminateServicePermission,
} as const satisfies Record<ScopeId, Permission>

/** Scopes `prepare_setup_request` asks for when it names a key but no scopes. */
export const DEFAULT_SCOPES: ScopeId[] = [
  'createDataSet',
  'addPieces',
  'schedulePieceRemovals',
]

/** Expiry, in days, when a link does not set one. */
export const DEFAULT_DAYS = 30

/** Longest expiry, in days, a link or the form accepts. */
export const MAX_DAYS = 365

/** Longest session-key name (the on-chain `origin`) a link accepts. */
export const MAX_NAME_LENGTH = 64

/** Session-key name when a link does not set one. */
export const DEFAULT_NAME = 'filecoin-app'

/**
 * Whether a value is a known scope ID.
 *
 * @param value - Candidate scope ID.
 */
export function isScopeId(value: string): value is ScopeId {
  return (SCOPE_IDS as readonly string[]).includes(value)
}

/**
 * Parse a comma-separated scope list, keeping known IDs in display order.
 * IDs match case-insensitively, and unknown entries are dropped.
 *
 * @param value - Link value, e.g. `createDataSet,addPieces`.
 * @returns The scopes, or `undefined` when none are known.
 */
export function parseScopes(value: string): ScopeId[] | undefined {
  const requested = new Set(
    value.split(',').map((scope) => scope.trim().toLowerCase())
  )
  const scopes = SCOPE_IDS.filter((scope) => requested.has(scope.toLowerCase()))
  return scopes.length > 0 ? scopes : undefined
}

/**
 * Whether a value is a whole number of days between 1 and {@link MAX_DAYS}.
 *
 * @param value - Candidate number of days.
 */
export function isValidDays(value: string) {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= MAX_DAYS
}

/**
 * Raw search params of `/dashboard/setup`, kept as strings so that
 * {@link parseSetupLink} can refuse a link whose values cannot be read. The
 * router parses every param as a flat string (see `src/router.tsx`).
 */
export const setupSearchSchema = z.object({
  network: z.string().optional().catch(undefined),
  authorize: z.string().optional().catch(undefined),
  signer: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  scopes: z.string().optional().catch(undefined),
  days: z.string().optional().catch(undefined),
  deposit: z.string().optional().catch(undefined),
  balance: z.string().optional().catch(undefined),
  operator: z.string().optional().catch(undefined),
  approval: z.string().optional().catch(undefined),
})

/** Raw search params of `/dashboard/setup`. */
export type SetupSearch = z.infer<typeof setupSearchSchema>

/** Why a setup link was refused. Any one of them refuses the whole request. */
export type SetupLinkError =
  | 'bad-checksum'
  | 'not-an-address'
  | 'no-network'
  | 'no-scopes'
  | 'bad-deposit'
  | 'bad-balance'
  | 'bad-operator'
  | 'bad-approval'

/** The session key a setup link asks to authorize. */
export interface SessionKeyRequest {
  /** Session-key address, lowercased. */
  address: Address
  /** Requested scopes; the owner can drop some but never add others. */
  scopes: ScopeId[]
  /** Suggested name, or `null` to use {@link DEFAULT_NAME}. The owner can edit it. */
  name: string | null
  /** Suggested expiry in days, or `null` to use {@link DEFAULT_DAYS}. The owner can edit it. */
  days: number | null
}

/** A setup request, as {@link parseSetupLink} reads it from a link. */
export interface SetupRequest {
  /** The network the request is for; `null` only for a bare link, which uses the wallet's network. */
  network: Network | null
  /** The session key to authorize; `null` when the link asks for none. */
  sessionKey: SessionKeyRequest | null
  /** Decimal USDFC to add on top of what Filecoin Pay holds; `null` when the link names none. */
  deposit: string | null
  /** Decimal USDFC the tool needs available in Filecoin Pay; `null` when the link names none. */
  balance: string | null
  /**
   * The link asks only for the Warm Storage approval: it names the operator
   * or the approval but no deposit or balance. Any other link also asks for
   * funds, at the amount it names or any balance at all.
   */
  approvalOnly: boolean
  /**
   * `approval=unlimited`: Warm Storage counts as approved only without
   * spending limits, as tools built on synapse-core need before they upload.
   */
  unlimitedApproval: boolean
}

/** Params that make a link a request; a link with none of them is bare. */
const REQUEST_PARAMS = [
  'network',
  'authorize',
  'signer',
  'scopes',
  'deposit',
  'balance',
  'operator',
  'approval',
] as const satisfies (keyof SetupSearch)[]

/** A plain positive decimal with at most 18 fraction digits (USDFC decimals). */
const AMOUNT = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/

/**
 * A positive decimal USDFC amount, or `null` when the value is unusable.
 *
 * @param value - Link value, e.g. `1.5`.
 */
export function parseAmount(value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  return AMOUNT.test(text) && /[1-9]/.test(text) ? text : null
}

/**
 * A session-key name, trimmed and capped at {@link MAX_NAME_LENGTH}
 * characters, or `null` when blank.
 *
 * @param value - Link value.
 */
function parseName(value: string | undefined): string | null {
  const name = value?.trim().slice(0, MAX_NAME_LENGTH).trim() ?? ''
  return name.length > 0 ? name : null
}

/**
 * Days until expiry, capped at {@link MAX_DAYS}, or `null` when unusable.
 *
 * @param value - Link value.
 */
function parseDays(value: string | undefined): number | null {
  const text = value?.trim() ?? ''
  if (!/^\d+$/.test(text) || Number(text) < 1) return null
  return Math.min(Number(text), MAX_DAYS)
}

/**
 * Read a setup request from the page's search params. A partial request is
 * never set up: an address, network, scope list, amount, operator or approval
 * the link names but that cannot be read refuses everything. The name and the
 * days are only suggestions, so an unusable one falls back to its default.
 *
 * The params follow the Filecoin Pay console's `/console/setup` contract, so
 * the same link works on both pages. `authorize` and `signer` both name the
 * session key.
 *
 * @param search - Raw search params; see {@link setupSearchSchema}.
 * @returns The request, or the first reason it cannot be used.
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/main/apps/explorer/src/utils/setupLink.ts
 */
export function parseSetupLink(
  search: SetupSearch
): SetupRequest | { error: SetupLinkError } {
  const has = (key: keyof SetupSearch) => search[key] !== undefined
  if (!REQUEST_PARAMS.some(has)) {
    return {
      network: null,
      sessionKey: null,
      deposit: null,
      balance: null,
      approvalOnly: false,
      unlimitedApproval: false,
    }
  }

  let sessionKey: SessionKeyRequest | null = null
  // Scopes without an address is still a session-key request, just a broken one.
  if (has('authorize') || has('signer') || has('scopes')) {
    const address = (search.authorize ?? search.signer ?? '').trim()
    if (!isAddress(address, { strict: false })) {
      return { error: 'not-an-address' }
    }
    // Strict mode accepts all-lowercase hex or a correct EIP-55 checksum.
    if (!isAddress(address)) return { error: 'bad-checksum' }
    sessionKey = {
      address: address.toLowerCase() as Address,
      // Checked after the network, so a link with neither reports the network.
      scopes: parseScopes(search.scopes ?? '') ?? [],
      name: parseName(search.name),
      days: parseDays(search.days),
    }
  }

  // Without it, a calibration link approved by a mainnet wallet would grant on mainnet.
  const network = search.network?.trim().toLowerCase()
  if (!network || !(NETWORKS as readonly string[]).includes(network)) {
    return { error: 'no-network' }
  }
  if (sessionKey && sessionKey.scopes.length === 0) {
    return { error: 'no-scopes' }
  }

  // Named but empty or zero is not "no deposit": the link asked for an amount it did not give.
  const deposit = has('deposit') ? parseAmount(search.deposit) : null
  if (has('deposit') && !deposit) return { error: 'bad-deposit' }
  const balance = has('balance') ? parseAmount(search.balance) : null
  if (has('balance') && !balance) return { error: 'bad-balance' }
  // Warm Storage is the only operator a link can name, and the page always offers it.
  if (has('operator') && search.operator?.trim().toLowerCase() !== 'fwss') {
    return { error: 'bad-operator' }
  }
  // Misspelled is refused, not read as "any approval": the tool would then refuse to upload.
  if (
    has('approval') &&
    search.approval?.trim().toLowerCase() !== 'unlimited'
  ) {
    return { error: 'bad-approval' }
  }

  return {
    network: network as Network,
    sessionKey,
    deposit,
    balance,
    approvalOnly:
      deposit === null &&
      balance === null &&
      (has('operator') || has('approval')),
    unlimitedApproval: has('approval'),
  }
}

/** What each {@link SetupLinkError} means, for the page and for agents. */
export const SETUP_LINK_ERRORS: Record<SetupLinkError, string> = {
  'bad-checksum': 'The session key address is misspelled.',
  'not-an-address': 'It does not contain a valid session key address.',
  'no-network': 'It does not say which network it is for.',
  'no-scopes': 'It does not say what the session key may do.',
  'bad-deposit': 'Its deposit amount cannot be read.',
  'bad-balance': 'The balance it asks for cannot be read.',
  'bad-operator': 'It names a service this page does not set up.',
  'bad-approval':
    'It asks for a kind of Warm Storage approval this page does not know.',
}

/** A setup request as an agent describes it to `prepare_setup_request`. */
export interface SetupRequestInput {
  network?: Network
  signer?: string
  name?: string
  scopes?: readonly string[]
  days?: number
  deposit?: string
  balance?: string
  unlimitedApproval?: boolean
}

/**
 * Validate an agent's setup request and turn it into `/dashboard/setup`
 * search params. The input is checked by shape as well as value, because
 * browser agents do not all enforce a tool's input schema before calling it.
 * Unlike a link, the request may leave out the network, which then defaults
 * to `defaultNetwork`, and the scopes, which default to {@link DEFAULT_SCOPES}.
 *
 * @param input - Request from an agent tool call, expected to be a {@link SetupRequestInput}.
 * @param defaultNetwork - Network to use when the request names none, such as the wallet's.
 * @returns The search params, or the problems that make the request invalid.
 * @see https://docs.mcp-b.ai/reference/webmcp/codex-site-tools
 */
export function toSetupSearch(
  input: unknown,
  defaultNetwork?: Network
): { search: SetupSearch } | { errors: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { errors: ['The request must be an object.'] }
  }
  const request = input as Partial<Record<keyof SetupRequestInput, unknown>>
  const errors: string[] = []
  const text = (key: keyof SetupRequestInput) => {
    const value = request[key]
    if (value === undefined) return undefined
    if (typeof value === 'string') return value
    errors.push(`${key} must be a string.`)
    return undefined
  }

  const search: SetupSearch = {}
  const network = request.network ?? defaultNetwork
  if (network === undefined) {
    errors.push(`network is required: one of ${NETWORKS.join(', ')}.`)
  } else if (
    typeof network !== 'string' ||
    !(NETWORKS as readonly string[]).includes(network)
  ) {
    errors.push(`network must be one of: ${NETWORKS.join(', ')}.`)
  } else {
    search.network = network
  }

  search.signer = text('signer')
  if (search.signer !== undefined) {
    if (isAddress(search.signer.trim(), { strict: false })) {
      // A mixed-case address from an agent is often mis-cased; lowercase it.
      search.signer = search.signer.trim().toLowerCase()
    } else {
      errors.push('signer must be a 20-byte hex address.')
    }
  }
  search.name = text('name')
  if (
    search.name !== undefined &&
    (search.name.trim().length === 0 || search.name.length > MAX_NAME_LENGTH)
  ) {
    errors.push(`name must be 1 to ${MAX_NAME_LENGTH} characters.`)
  }

  if (Array.isArray(request.scopes)) {
    const unknown = request.scopes.filter(
      (scope) => typeof scope !== 'string' || !isScopeId(scope)
    )
    if (unknown.length > 0) {
      errors.push(
        `Unknown scopes: ${unknown.join(', ')}. Use: ${SCOPE_IDS.join(', ')}.`
      )
    } else if (request.scopes.length === 0) {
      errors.push(`scopes must name at least one of: ${SCOPE_IDS.join(', ')}.`)
    } else {
      search.scopes = request.scopes.join(',')
    }
  } else if (request.scopes !== undefined) {
    errors.push(`scopes must be an array of: ${SCOPE_IDS.join(', ')}.`)
  } else if (search.signer !== undefined) {
    search.scopes = DEFAULT_SCOPES.join(',')
  }

  if (request.days !== undefined) {
    if (isValidDays(String(request.days))) {
      search.days = String(request.days)
    } else {
      errors.push(`days must be a whole number from 1 to ${MAX_DAYS}.`)
    }
  }
  for (const key of ['deposit', 'balance'] as const) {
    const value = text(key)
    if (value === undefined) continue
    if (parseAmount(value) === null) {
      errors.push(`${key} must be a positive USDFC amount, e.g. "1.5".`)
    } else {
      search[key] = value.trim()
    }
  }
  if (request.unlimitedApproval === true) {
    search.approval = 'unlimited'
  } else if (
    request.unlimitedApproval !== undefined &&
    request.unlimitedApproval !== false
  ) {
    errors.push('unlimitedApproval must be a boolean.')
  }
  if (
    (search.name !== undefined ||
      request.scopes !== undefined ||
      search.days) &&
    search.signer === undefined
  ) {
    errors.push('name, scopes, and days need a signer.')
  }

  if (errors.length > 0) {
    return { errors }
  }
  return {
    search: Object.fromEntries(
      Object.entries(search).filter(([, value]) => value !== undefined)
    ),
  }
}

/**
 * Unix time, in seconds, `days` days after `now`.
 *
 * @param days - Days until expiry.
 * @param now - Current time in Unix milliseconds.
 */
export function expiryFromDays(days: number, now = Date.now()) {
  return BigInt(Math.floor(now / 1000) + days * 86_400)
}

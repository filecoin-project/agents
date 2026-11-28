/**
 * Group key Grants: how a session key gets the owner's group key, or a group
 * within it, without the owner wallet.
 *
 * The owner approves the session key in the Filecoin Pay console. The console
 * signs a Keysmith root claim for the whole group key (`node: 'groupKey'`) or
 * one group (`group:<path>`), with the session key as bearer, wraps that
 * node's key to the session key's public key, and shows the result as one
 * line of text: `fgr1_` and the unpadded base64url of Keysmith's
 * `encodeDelivery(chain, grant)`. A client stores that text, never the key it
 * opens.
 *
 * Keysmith's `openDelivery` checks the signatures, the expiry, that the
 * session key is the bearer, and the unwrapped key against the commitment the
 * owner signed. It doesn't know which owner, group key, or network to expect,
 * so {@link openGrant} checks those.
 *
 * Ported from filecoin-pin's `src/common/group-key-grant.ts` on
 * `feat/encryption-v2`. The console link parameters follow the console's
 * `setupLink.ts`.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/group-key-grant.ts
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 * @module
 */

import {
  deriveGroupKey,
  encodeDelivery,
  type GrantNode,
  grantDescriptor,
  MAX_CHAIN_LENGTH,
  publicKeyOf,
  rootClaim,
  wrapTo,
} from '@filoz/keysmith'
import { type Address, type Hex, verifyMessage } from 'viem'
import { EncryptionError, errorCode, GrantError } from './errors.ts'
import {
  checkAddress,
  checkGroup,
  isCommitment,
  type OwnerSigner,
} from './group-key.ts'
import { toBase64url } from './internal/bytes.ts'
import {
  checkChainId,
  normalizeGrantText,
  sessionAccount,
} from './internal/grant-text.ts'
import { openGrantWithKey } from './internal/opened-grant.ts'
import { GRANT_PREFIX } from './internal/prefixes.ts'

export {
  type DecodedGrantText,
  decodeGrantText,
  normalizeGrantText,
  precheckGrant,
} from './internal/grant-text.ts'
export { GRANT_PREFIX }

/** The prefix a session key signs, with EIP-191, to bind its key-agreement public key to its address. */
export const KEY_AGREEMENT_PREFIX = 'Keysmith key agreement key: '

/**
 * The most onward links a Grant may allow (`maxdepth` in the console link):
 * Keysmith's chain limit less the root claim. This package defaults to 0,
 * because neither the CLI nor the package delegates onward.
 */
export const MAX_GRANT_DEPTH: number = MAX_CHAIN_LENGTH - 1

/** Separator between Grants in a stored list. Base64url never contains it. */
const GRANT_SEPARATOR = ','

/**
 * What a session key signs over its key-agreement public key, as the console
 * checks it.
 *
 * @param pubkey - The uncompressed secp256k1 public key, `0x04` and 128 hex digits.
 */
export const keyAgreementMessage = (pubkey: Hex): string =>
  `${KEY_AGREEMENT_PREFIX}${pubkey.toLowerCase()}`

/**
 * `pubkey` and `pubkeysig` for the console link: the session key's
 * key-agreement public key, and the session key's EIP-191 signature binding
 * it to the session address.
 *
 * @param sessionKey - The session key's private key.
 * @throws {GrantError} `bad-session-key`.
 */
export async function keyAgreementParams(
  sessionKey: Hex
): Promise<{ pubkey: Hex; pubkeysig: Hex }> {
  const account = sessionAccount(sessionKey)
  const pubkey = publicKeyOf(sessionKey).toLowerCase() as Hex
  const pubkeysig = await account.signMessage({
    message: keyAgreementMessage(pubkey),
  })
  return { pubkey, pubkeysig }
}

/**
 * Whether the key at `address` signed `pubkey` as its key-agreement key.
 * Never throws.
 *
 * @param address - The session address.
 * @param params - The `pubkey` and `pubkeysig` from a console link.
 */
export function verifyKeyAgreementKey(
  address: Address,
  params: { pubkey: Hex; pubkeysig: Hex }
): Promise<boolean> {
  return verifyMessage({
    address,
    message: keyAgreementMessage(params.pubkey),
    signature: params.pubkeysig,
  }).catch(() => false)
}

/** What a Grant request asks for in the console link. */
export interface GrantRequest {
  /** The session key's private key, which signs `pubkeysig`. */
  sessionKey: Hex
  /** A group path for one group's Grant; undefined for the whole group key. */
  group?: string | undefined
  /** Onward links the bearer may add, `0` to {@link MAX_GRANT_DEPTH}. Defaults to 0. */
  maxDepth?: number | undefined
}

/** Whether `depth` is a valid `maxDepth`: an integer from 0 to {@link MAX_GRANT_DEPTH}. */
const validDepth = (depth: number): boolean =>
  Number.isInteger(depth) && depth >= 0 && depth <= MAX_GRANT_DEPTH

/** The Keysmith node for a group path, or the whole group key. */
function grantNode(group: string | undefined): GrantNode {
  if (group == null) return 'groupKey'
  try {
    return `group:${checkGroup(group)}`
  } catch (error) {
    throw new GrantError(
      'bad-group',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/**
 * The Grant parameters of the console's `/console/setup` link: `pubkey`,
 * `pubkeysig`, `node`, and `maxdepth`, which is always written (0 unless the
 * request asks for more), so the console's default never applies. The link also needs
 * `authorize`, `network`, and `scopes` with `addPieces`, which the caller adds.
 *
 * @param request - The session key and what it asks for.
 * @throws {GrantError} `bad-group`, `bad-maxdepth`, or `bad-session-key`.
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 */
export async function grantLinkParams(
  request: GrantRequest
): Promise<Record<string, string>> {
  const node = grantNode(request.group)
  const maxDepth = request.maxDepth ?? 0
  if (!validDepth(maxDepth)) {
    throw new GrantError(
      'bad-maxdepth',
      `maxDepth must be an integer from 0 to ${MAX_GRANT_DEPTH}`
    )
  }
  const { pubkey, pubkeysig } = await keyAgreementParams(request.sessionKey)
  return { pubkey, pubkeysig, node, maxdepth: String(maxDepth) }
}

/** The Grant request a console link carries, as {@link parseGrantLinkParams} reads it. */
export interface GrantLinkRequest {
  /** The session key's key-agreement public key, lowercase. */
  pubkey: Hex
  /** The session key's EIP-191 signature over {@link keyAgreementMessage}, lowercase. Not yet checked. */
  pubkeysig: Hex
  /** The group path, or undefined for the whole group key. */
  group?: string
  /** Onward links the bearer may add. 0 when the link leaves `maxdepth` out. */
  maxDepth: number
}

/**
 * Read the Grant parameters of a console link with the console's rules:
 * `pubkey` is `0x04` and 128 hex digits, `pubkeysig` 130 hex digits, `node`
 * is `groupKey` or `group:<path>`, and `maxdepth`, if present, one digit up to
 * {@link MAX_GRANT_DEPTH}. It returns undefined when the link has none of the
 * four. It checks formats only: {@link verifyKeyAgreementKey} checks the
 * signature, and {@link issueGrant} checks it again. Whether the link's
 * session key may get a Grant (`addPieces` in its scopes) is the caller's
 * check.
 *
 * Unlike the console, a link without `maxdepth` asks for depth 0, not
 * {@link MAX_GRANT_DEPTH}.
 *
 * @param params - The link's query parameters.
 * @throws {GrantError} `bad-pubkey`, `bad-pubkeysig`, `old-cli` (a `keyspace` or `scope:` node from filecoin-pin 2.3 or 2.4), `bad-group`, `bad-node`, or `bad-maxdepth`.
 * @see https://github.com/FilOzone/filecoin-pay-explorer/blob/staging/apps/explorer/src/utils/setupLink.ts
 */
export function parseGrantLinkParams(
  params: URLSearchParams
): GrantLinkRequest | undefined {
  if (!['pubkey', 'pubkeysig', 'node', 'maxdepth'].some((k) => params.has(k)))
    return undefined
  const pubkey = params.get('pubkey')?.trim().toLowerCase() ?? ''
  // Format only: Keysmith refuses a point off the curve when it wraps the Grant.
  if (!/^0x04[0-9a-f]{128}$/.test(pubkey))
    throw new GrantError('bad-pubkey', 'The link has no valid pubkey')
  const pubkeysig = params.get('pubkeysig')?.trim().toLowerCase() ?? ''
  if (!/^0x[0-9a-f]{130}$/.test(pubkeysig))
    throw new GrantError('bad-pubkeysig', 'The link has no valid pubkeysig')
  const node = params.get('node')
  let group: string | undefined
  if (node === 'keyspace' || node?.startsWith('scope:')) {
    throw new GrantError(
      'old-cli',
      'The link is from filecoin-pin 2.3 or 2.4, which cannot open this Grant; update the CLI'
    )
  }
  if (node?.startsWith('group:')) {
    group = grantNode(node.slice('group:'.length)).slice('group:'.length)
  } else if (node !== 'groupKey') {
    throw new GrantError(
      'bad-node',
      'The link asks for no valid node: expected groupKey or group:<path>'
    )
  }
  // Exactly one digit in range: "07", "7.0", and " 7" are refused, not read as 7.
  const depth = params.get('maxdepth')
  if (depth != null && !(/^\d$/.test(depth) && validDepth(Number(depth)))) {
    throw new GrantError(
      'bad-maxdepth',
      `maxdepth must be one digit from 0 to ${MAX_GRANT_DEPTH}`
    )
  }
  return {
    pubkey: pubkey as Hex,
    pubkeysig: pubkeysig as Hex,
    ...(group != null && { group }),
    maxDepth: depth == null ? 0 : Number(depth),
  }
}

/**
 * The text form of a Keysmith delivery: `fgr1_` and its unpadded base64url.
 *
 * @param delivery - The bytes of `encodeDelivery(chain, grant)`.
 */
export function grantText(delivery: Uint8Array): string {
  return `${GRANT_PREFIX}${toBase64url(delivery)}`
}

/**
 * The stored form of several Grants of one group key: comma-joined.
 *
 * @param texts - Grant texts.
 */
export function joinGrants(texts: readonly string[]): string {
  return texts.join(GRANT_SEPARATOR)
}

/**
 * The Grants in a stored list, whitespace removed and empty entries dropped.
 *
 * @param text - A comma-joined list.
 */
export function splitGrants(text: string): string[] {
  return text
    .split(GRANT_SEPARATOR)
    .map(normalizeGrantText)
    .filter((t) => t !== '')
}

/** What a Grant must match. */
export interface GrantExpectations {
  /** The session key the Grant must be wrapped to. */
  sessionKey: Hex
  /** The wallet that authorized the session key. */
  walletAddress: string
  /** The network's chain id. Undefined skips the check, for an offline read. */
  chainId?: number | bigint | undefined
  /** The saved group key id, when loading a saved Grant. */
  groupKeyId?: string | undefined
  /** Unix seconds, for tests. Defaults to now. */
  now?: number | undefined
}

/** What an opened Grant covers. It holds no key. */
export interface GrantInfo {
  /** The Grant text without whitespace, as a client stores it. */
  text: string
  /** The group key id (`foc/gkid`), lowercase. */
  groupKeyId: Hex
  /** The group the Grant covers, with every group beneath it; undefined for the whole group key. */
  group?: string
  /** The owner wallet that signed the Grant. */
  owner: Address
  /** The network's chain id the Grant is for. */
  chainId: bigint
  /** Unix seconds after which the Grant no longer opens. */
  expires: number
  /** `foc/kc` for new data sets: the commitment the owner signed, in metadata form. */
  commitment: string
}

/**
 * Open a Grant for this session key and check that it is for this owner,
 * network, and group key, for a group key or a group and not a piece, and not
 * expired. Use it when a login imports a Grant, then store `text`. The key
 * the Grant opens is zeroed before this returns.
 *
 * @param rawText - The Grant as pasted.
 * @param expected - What the Grant must match.
 * @throws {GrantError} With the reason it is refused. Grant checks come before key checks, so each refusal names its own reason. `bad-session-key` or `bad-chain-id` for an expectation that isn't one, before the Grant is read.
 * @throws {EncryptionError} `bad-address` for a `walletAddress` that isn't an address, naming no value.
 */
export async function openGrant(
  rawText: string,
  expected: GrantExpectations
): Promise<GrantInfo> {
  const opened = await openGrantWithKey(rawText, expected)
  opened.key.fill(0)
  const { claim: _claim, grant: _grant, key: _key, ...info } = opened
  return info
}

/**
 * What a Grant covers, for messages: `group key 0x…` or `group a/b of group key 0x…`.
 *
 * @param info - An opened Grant.
 */
export function grantCovers(
  info: Pick<GrantInfo, 'group' | 'groupKeyId'>
): string {
  return info.group == null
    ? `group key ${info.groupKeyId}`
    : `group ${info.group} of group key ${info.groupKeyId}`
}

/** What the owner side needs to issue a Grant, as the console does. */
export interface IssueGrantInput {
  /** The owner wallet, which signs the group key and the root claim. */
  owner: OwnerSigner
  /** The group key to share. */
  groupKeyId: Hex
  /** The recorded `foc/kc`, if any: the derived key is checked against it, and the wallet signs once. Null or undefined for a new group key. */
  commitment?: string | null | undefined
  /** The network's chain id. */
  chainId: number | bigint
  /** The session address, the Grant's bearer. */
  bearer: Address
  /** The session key's key-agreement key and its signature, from {@link grantLinkParams}. */
  pubkey: Hex
  /** The session key's EIP-191 signature over {@link keyAgreementMessage}. */
  pubkeysig: Hex
  /** A group path for one group's Grant; undefined for the whole group key. */
  group?: string | undefined
  /** Onward links the bearer may add, 0 to {@link MAX_GRANT_DEPTH}. Defaults to 0. */
  maxDepth?: number | undefined
  /** Unix seconds when the Grant stops opening. */
  expires: number | bigint
  /** Unix seconds, for tests. */
  now?: number | undefined
}

/**
 * Issue a group key Grant from the owner side, as the console does: derive the
 * group key, sign a root claim with the session key as bearer, wrap the node's
 * key to the session key's key-agreement key, and return the `fgr1_` text.
 * The key-agreement key must be signed by the bearer. Every derived key this
 * package holds is zeroed before this returns.
 *
 * @param input - The owner, the group key, and the session key.
 * @throws {GrantError} `bad-maxdepth`, `bad-expires` for an expiry not in the future, `bad-chain-id` for one Keysmith can't read back, `format-1` or `bad-commitment` for a `commitment` Keysmith can't check a key against, `bad-group-key`, `bad-pubkey` for a key that isn't an uncompressed secp256k1 point, `bad-pubkeysig` when the bearer didn't sign `pubkey`, or `bad-group`. Each is checked before the wallet is asked to sign.
 * @throws {EncryptionError} `bad-address` for an owner or bearer address that isn't one, or is mixed case with a wrong EIP-55 checksum, before the wallet is asked to sign. `issue-failed`, naming only an error code, with the original as `cause`, when the wallet refuses to sign or Keysmith refuses the key it signed for, such as one that doesn't match `commitment`.
 */
export async function issueGrant(input: IssueGrantInput): Promise<string> {
  const maxDepth = input.maxDepth ?? 0
  if (!validDepth(maxDepth)) {
    throw new GrantError(
      'bad-maxdepth',
      `maxDepth must be an integer from 0 to ${MAX_GRANT_DEPTH}`
    )
  }
  const expires = Number(input.expires)
  // The time rootClaim checks against, so a past expiry fails here, before the wallet signs.
  const now = input.now ?? Math.floor(Date.now() / 1000)
  if (!(Number.isSafeInteger(expires) && expires > now)) {
    throw new GrantError(
      'bad-expires',
      'expires must be a whole number of Unix seconds in the future'
    )
  }
  // Keysmith writes the chain id as a CBOR number and reads back only a safe integer.
  const chainId = checkChainId(input.chainId)
  // Strict, as viem and Keysmith check them after the wallet has signed: mixed case must carry a valid EIP-55 checksum.
  checkAddress(input.owner.address, 'owner')
  checkAddress(input.bearer, 'bearer')
  const { commitment } = input
  if (commitment != null && !isCommitment(commitment)) {
    throw /^v1\./.test(commitment)
      ? new GrantError(
          'format-1',
          'The recorded commitment is from format 1 (filecoin-pin 2.3 or 2.4), which this version no longer writes.'
        )
      : new GrantError(
          'bad-commitment',
          'The recorded commitment is not `v2.` and 32 lowercase hex.'
        )
  }
  const node = grantNode(input.group)
  const ref = { owner: input.owner.address, groupKeyId: input.groupKeyId }
  let descriptor: ReturnType<typeof grantDescriptor>
  try {
    descriptor = grantDescriptor(ref, node)
  } catch {
    throw new GrantError(
      'bad-group-key',
      'The group key id is not a valid group key id.'
    )
  }
  // A trial wrap checks the point exactly as the real one will, before any wallet prompt.
  const trial = new Uint8Array(32)
  try {
    if (!/^0x04[0-9a-fA-F]{128}$/.test(input.pubkey)) throw new Error()
    await wrapTo(input.pubkey, trial, descriptor)
  } catch {
    throw new GrantError(
      'bad-pubkey',
      'The key-agreement key is not an uncompressed secp256k1 public key.'
    )
  }
  if (!(await verifyKeyAgreementKey(input.bearer, input))) {
    throw new GrantError(
      'bad-pubkeysig',
      `The key-agreement key is not signed by ${input.bearer}.`
    )
  }
  try {
    const { groupKey } = await deriveGroupKey(
      input.owner,
      ref,
      commitment == null ? {} : { commitment }
    )
    try {
      // Keysmith 0.2.0 derives the node key before the wallet signs, and leaves it unzeroed when the wallet refuses. This package never sees that buffer.
      const { chain, nodeKey } = await rootClaim(input.owner, {
        ...ref,
        chainId,
        groupKey,
        node,
        bearer: input.bearer,
        maxDepth,
        expires,
        ...(input.now != null && { now: input.now }),
      })
      try {
        const grant = await wrapTo(input.pubkey, nodeKey, descriptor)
        return grantText(encodeDelivery(chain, grant))
      } finally {
        nodeKey.fill(0)
      }
    } finally {
      groupKey.fill(0)
    }
  } catch (error) {
    // A wallet that refused to sign, or a key Keysmith refused, has no code of its own.
    if (error instanceof EncryptionError) throw error
    throw new EncryptionError(
      'issue-failed',
      `Issuing the Grant failed: ${errorCode(error)}`,
      { cause: error }
    )
  }
}

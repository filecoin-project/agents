/**
 * An opened Grant with its key. Internal: no public entry point exports this
 * module, so the key never leaves the package.
 *
 * @module
 */

import { type Grant, openDelivery, type VerifiedClaim } from '@filoz/keysmith'
import type { Address } from 'viem'
import { GrantError } from '../errors.ts'
import type { GrantExpectations, GrantInfo } from '../grant.ts'
import { checkAddress } from '../group-key.ts'
import { sameAddress } from './bytes.ts'
import {
  checkChainId,
  checkDecodedGrant,
  checkNow,
  decodeGrantText,
  expiryText,
  sessionAccount,
} from './grant-text.ts'

/**
 * An opened Grant with the key of its node. Internal: the key never leaves
 * the call that needs it, and that call zeroes it.
 *
 * @internal
 */
export interface OpenedGrant extends GrantInfo {
  /** The verified final claim, as Keysmith's `pickGrant` reads it. */
  claim: VerifiedClaim
  /** The wrapped key's descriptor. */
  grant: Grant
  /** The key of the Grant's node: the group key, or its group's key. */
  key: Uint8Array
}

/**
 * Check what a session gave before any Grant is read: a refusal that compares
 * a Grant with it would repeat it. A session with several Grants calls it
 * once, so its own mistake is reported once.
 *
 * @internal
 * @param expected - What the Grants must match.
 * @throws {EncryptionError} `bad-address` for the wallet address.
 * @throws {GrantError} `bad-chain-id`, `bad-group-key`, or `bad-session-key`.
 * @throws {RangeError} For a `now` that isn't Unix seconds.
 */
export function checkExpectations(expected: GrantExpectations): {
  sessionAddress: Address
  now: number
} {
  checkAddress(expected.walletAddress, 'session wallet address')
  if (expected.chainId != null) checkChainId(expected.chainId)
  if (
    expected.groupKeyId != null &&
    !/^0x[0-9a-fA-F]{32}$/.test(expected.groupKeyId)
  ) {
    throw new GrantError(
      'bad-group-key',
      'The saved group key id is not 0x and 32 hex digits'
    )
  }
  const sessionAddress = sessionAccount(expected.sessionKey).address
  const now = expected.now ?? Math.floor(Date.now() / 1000)
  checkNow(now)
  return { sessionAddress, now }
}

/**
 * Open a Grant and check it, keeping its key. Internal: callers outside this
 * package use {@link openGrant}, which zeroes the key.
 *
 * @internal
 */
export async function openGrantWithKey(
  rawText: string,
  expected: GrantExpectations
): Promise<OpenedGrant> {
  const { sessionAddress, now } = checkExpectations(expected)
  const { text, bytes, delivery } = decodeGrantText(rawText)
  checkDecodedGrant(delivery, sessionAddress, now)

  let opened: Awaited<ReturnType<typeof openDelivery>>
  try {
    // Keysmith 0.2.0 leaves the key it unwrapped unzeroed when the commitment check after it fails. This package never sees that buffer.
    opened = await openDelivery(expected.sessionKey, bytes, { now })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new GrantError(
      'does-not-verify',
      `The Grant does not verify (${reason}); copy it again from the console.`
    )
  }
  try {
    return checkOpened(text, opened, expected)
  } catch (error) {
    // Any throw from the checks, a GrantError or not, leaves the key zeroed.
    opened.key.fill(0)
    throw error
  }
}

/** Check an opened Grant against what the session expects, and describe it. */
function checkOpened(
  text: string,
  opened: Awaited<ReturnType<typeof openDelivery>>,
  expected: GrantExpectations
): OpenedGrant {
  const { claim, grant, key } = opened
  const refuse = (code: string, message: string): never => {
    throw new GrantError(code, message)
  }
  if (opened.expired)
    refuse('expired', `This Grant expired at ${expiryText(claim.expires)}.`)
  if (!sameAddress(claim.owner, expected.walletAddress)) {
    refuse(
      'wrong-owner',
      `This Grant is from wallet ${claim.owner}, not ${expected.walletAddress}, which authorized this session key.`
    )
  }
  if (expected.chainId != null && claim.chainId !== BigInt(expected.chainId)) {
    refuse(
      'wrong-network',
      `This Grant is for another network (chain id ${claim.chainId}, not ${expected.chainId}).`
    )
  }
  if (
    expected.groupKeyId != null &&
    claim.groupKeyId !== expected.groupKeyId.toLowerCase()
  ) {
    refuse(
      'wrong-group-key',
      `This Grant is for group key ${claim.groupKeyId}, but the saved group key is ${expected.groupKeyId}.`
    )
  }
  let group: string | undefined
  if (claim.node.startsWith('group:')) group = claim.node.slice('group:'.length)
  else if (claim.node !== 'groupKey') {
    // A piece Grant opens one existing piece: it can neither write nor read a group.
    refuse(
      'piece-grant',
      `This Grant covers ${claim.node}, not a group key or a group.`
    )
  }
  return {
    text,
    groupKeyId: claim.groupKeyId,
    ...(group != null && { group }),
    owner: claim.owner,
    chainId: claim.chainId,
    expires: claim.expires,
    // The claim carries `0x<32 hex>`; data set metadata records `v2.<32 hex>`.
    commitment: `v2.${claim.groupKeyCommitment.slice(2)}`,
    claim,
    grant,
    key,
  }
}

/**
 * Decoding a Grant's text and the checks that need no network. Re-exported
 * from `grant.ts`; kept apart so the internal Grant opener can use them
 * without an import cycle.
 *
 * @module
 */

import { type ClaimChain, decodeDelivery, type Grant } from '@filoz/keysmith'
import type { Address, Hex } from 'viem'
import type { privateKeyToAccount } from 'viem/accounts'
import { GrantError } from '../errors.ts'
import { format1Message } from '../group-key.ts'
import { accountOf, BASE64URL, fromBase64url, sameAddress } from './bytes.ts'
import {
  ACCESS_KEY_PREFIX,
  GRANT_PREFIX,
  SHARE_FRAGMENT_PREFIX,
} from './prefixes.ts'

/**
 * The Grant text as pasted, minus every whitespace character: consoles and
 * terminals wrap long lines.
 *
 * @param text - The pasted text.
 */
export function normalizeGrantText(text: string): string {
  return text.replace(/\s+/g, '')
}

/** The Grant's bytes, or a GrantError naming what the text looks like instead. */
function grantBytes(text: string): Uint8Array {
  if (text === '') throw new GrantError('no-grant', 'No Grant given.')
  if (!text.startsWith(GRANT_PREFIX)) {
    if (text.startsWith(ACCESS_KEY_PREFIX)) {
      throw new GrantError(
        'access-key-pasted',
        `This is an Access key, not a Grant. A Grant starts with ${GRANT_PREFIX}.`
      )
    }
    if (text.includes(`#${SHARE_FRAGMENT_PREFIX}`) || /https?:/i.test(text)) {
      throw new GrantError(
        'share-link-pasted',
        `This is a share link, not a Grant. A Grant starts with ${GRANT_PREFIX}.`
      )
    }
    throw new GrantError(
      'not-a-grant',
      `This is not a Grant: a Grant starts with ${GRANT_PREFIX}.`
    )
  }
  const body = text.slice(GRANT_PREFIX.length)
  if (body === '') throw incomplete()
  if (!BASE64URL.test(body)) {
    throw new GrantError(
      'not-a-grant',
      'This is not a Grant: it contains characters a Grant never has. Copy it again from the console.'
    )
  }
  // Only the length is left to be wrong: text cut short.
  const bytes = fromBase64url(body)
  if (bytes == null) throw incomplete()
  return bytes
}

const incomplete = (): GrantError =>
  new GrantError(
    'incomplete',
    'The Grant is incomplete or corrupted; copy it again from the console.'
  )

/** A Grant's text, decoded but not verified. */
export interface DecodedGrantText {
  /** The text without whitespace. */
  text: string
  /** The delivery bytes. */
  bytes: Uint8Array
  /** The claim chain and the wrapped key, unverified. */
  delivery: { chain: ClaimChain; grant: Grant }
}

/**
 * Decode a Grant's text without verifying it: the prefix, the base64url, and
 * the CBOR.
 *
 * @param rawText - The Grant as pasted.
 * @throws {GrantError} Naming what the text is instead, or that it is incomplete or format 1.
 */
export function decodeGrantText(rawText: string): DecodedGrantText {
  const text = normalizeGrantText(rawText)
  const bytes = grantBytes(text)
  try {
    return { text, bytes, delivery: decodeDelivery(bytes) }
  } catch (error) {
    // A Grant from filecoin-pin 2.3 or 2.4 is whole, in a format this version no longer reads.
    const format1 = format1Message(error)
    if (format1 != null)
      throw new GrantError('format-1', `${format1} Get a new Grant.`)
    throw incomplete()
  }
}

/**
 * The session key's account, or a `bad-session-key` that names no part of the
 * key: viem's own error for a short key or a scalar off the curve repeats it.
 *
 * @internal
 * @param sessionKey - The session key's private key.
 * @throws {GrantError} `bad-session-key`.
 */
export function sessionAccount(
  sessionKey: Hex
): ReturnType<typeof privateKeyToAccount> {
  const account = accountOf(sessionKey)
  if (account == null)
    throw new GrantError(
      'bad-session-key',
      'The session key is not a secp256k1 private key: 0x and 64 hex digits, not zero'
    )
  return account
}

/**
 * A chain id as Keysmith signs and reads it: a whole number from 1 to
 * `Number.MAX_SAFE_INTEGER`, since it writes a CBOR number.
 *
 * @internal
 * @param value - The chain id as given.
 * @throws {GrantError} `bad-chain-id`.
 */
export function checkChainId(value: number | bigint): bigint {
  const chainId =
    typeof value === 'bigint' || Number.isSafeInteger(value)
      ? BigInt(value)
      : 0n
  if (chainId < 1n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GrantError(
      'bad-chain-id',
      `chainId must be an integer from 1 to ${Number.MAX_SAFE_INTEGER}`
    )
  }
  return chainId
}

/**
 * The checks that need neither the owner nor the network, so a login can run
 * them before it waits for the authorization: the Grant decodes, names this
 * session key as its bearer, and hasn't expired. Unverified: {@link openGrant}
 * checks them all again with the signatures.
 *
 * @param rawText - The Grant as pasted.
 * @param sessionKey - The session key's private key.
 * @param now - Unix seconds.
 * @throws {GrantError} With the reason it is refused, or `bad-session-key` for a session key that isn't one.
 */
export function precheckGrant(
  rawText: string,
  sessionKey: Hex,
  now: number = Math.floor(Date.now() / 1000)
): void {
  const sessionAddress = sessionAccount(sessionKey).address
  checkNow(now)
  checkDecodedGrant(decodeGrantText(rawText).delivery, sessionAddress, now)
}

/**
 * Refuse a clock override that isn't Unix seconds: an expiry compared with
 * `NaN` never passes.
 *
 * @internal
 * @param now - Unix seconds.
 * @throws {RangeError} When `now` is not a whole number of at least 0.
 */
export function checkNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError('now must be a whole number of Unix seconds')
}

/**
 * An expiry for a message: an ISO date, or Unix seconds past the last date a
 * JavaScript `Date` holds.
 *
 * @internal
 * @param seconds - Unix seconds.
 */
export function expiryText(seconds: number): string {
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime())
    ? `Unix second ${seconds}`
    : date.toISOString()
}

/**
 * {@link precheckGrant} over a Grant already decoded, so an opener decodes
 * its text once.
 *
 * @param delivery - The decoded claim chain and wrapped key.
 * @param sessionAddress - The session key's address.
 * @param now - Unix seconds.
 * @throws {GrantError} With the reason it is refused.
 * @internal
 */
export function checkDecodedGrant(
  delivery: DecodedGrantText['delivery'],
  sessionAddress: Address,
  now: number
): void {
  const bearer = delivery.chain.links.at(-1)?.bearer
  if (bearer != null && !sameAddress(bearer, sessionAddress)) {
    throw new GrantError(
      'wrong-session-key',
      `This Grant is for another session key (${bearer}), not this one (${sessionAddress}).`
    )
  }
  if (delivery.chain.expires <= now) {
    throw new GrantError(
      'expired',
      `This Grant expired at ${expiryText(delivery.chain.expires)}.`
    )
  }
}

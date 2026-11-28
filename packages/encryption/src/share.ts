/**
 * Share links: one encrypted upload, shared with someone who has no key pair.
 *
 * A share is a Keysmith piece Grant: the upload's piece key wrapped to a
 * throwaway key T that the sender makes for the recipient. Nothing flows back
 * from the recipient, so it works for anyone on the web. T's private key
 * travels inside the link (an open link), or as an Access key that the
 * recipient gets by another channel (a restricted link):
 *
 *   <viewer>#v1/<encrypted root CID>&d=<payload>[&k=fak1_<key>]
 *
 * Every value is unpadded base64url. Everything is in the fragment, so no
 * server sees the key. Every link has its own T, so links are independent. A
 * share link can't be revoked.
 *
 * The payload is a plain piece Grant, which {@link createShare} makes, or a
 * Keysmith Delivery: a piece Grant with its signed claim chain, which can
 * expire. This module reads both and makes plain Grants only. Format 1 links,
 * from filecoin-pin 2.3 and 2.4, fail as `format-1`.
 *
 * The link grammar is the share link viewer's, so a link opens in both or in
 * neither: `d` then `k`, a base32 CID, and base64url that encodes back to the
 * same text.
 *
 * Ported from filecoin-pin's `src/common/share-link.ts` on `feat/encryption-v2`,
 * with the viewer's `src/fragment.ts` grammar and its Delivery handling.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/share-link.ts
 * @see https://github.com/FilOzone/filecoin-encryption-viewer/blob/main/src/fragment.ts
 * @see https://github.com/FilOzone/synapse-sdk/issues/1036
 * @module
 */

import {
  type ClaimChain,
  canonicalNode,
  decodeDelivery,
  decodeGrant,
  deriveGroupKey,
  encodeGrant,
  type Grant,
  grantDescriptor,
  keyForEnvelope,
  openDelivery,
  type PieceMetadata,
  pieceMetadata,
  pieceNode,
  publicKeyOf,
  unwrapWith,
  wrapTo,
} from '@filoz/keysmith'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import {
  type Address,
  bytesToHex,
  getAddress,
  type Hex,
  hexToBytes,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  EncryptionError,
  errorCode,
  NotOwnerError,
  ShareLinkError,
} from './errors.ts'
import { checkAddress, format1Message } from './group-key.ts'
import {
  accountOf,
  fromBase64url,
  sameAddress,
  toBase64url,
} from './internal/bytes.ts'
import { expiryText } from './internal/grant-text.ts'
import { readLabels } from './internal/labels.ts'
import {
  ACCESS_KEY_PREFIX,
  GRANT_PREFIX,
  SHARE_FRAGMENT_PREFIX,
} from './internal/prefixes.ts'
import { type Credentials, grantForPiece, openSessionGrants } from './keys.ts'

export { ACCESS_KEY_PREFIX }

/** The share link viewer that links open in (FilOzone/synapse-sdk#1036). */
export const DEFAULT_VIEWER_URL = 'https://viewer.filecoin.cloud/'

/** `open`: the link alone opens the upload. `restricted`: the link also needs its Access key. */
export type ShareMode = 'open' | 'restricted'

/** A parsed share link. */
export interface ParsedShare {
  /** The encrypted root CID: the outer CAR's root. */
  rootCid: CID
  /** A Keysmith piece Grant or Delivery, as CBOR. */
  payload: Uint8Array
  /** T's private key, when the link carries it (an open link). Absent from a restricted link. */
  accessKey?: Hex
}

/** The most characters of `d`, as the viewer reads it. */
const MAX_PAYLOAD_CHARS = 8192

/** The share link fragment, exactly as {@link formatShareLink} writes it. */
const FRAGMENT =
  /^v1\/(b[a-z2-7]{20,120})&d=([A-Za-z0-9_-]{1,8192})(?:&k=(fak1_[A-Za-z0-9_-]{43}))?$/

/** Base64url that encodes back to the same text: no stray bits in the last character. */
function unb64(text: string, what: string): Uint8Array {
  const decoded = fromBase64url(text)
  const bytes =
    decoded != null && toBase64url(decoded) === text ? decoded : null
  if (bytes == null)
    throw new ShareLinkError(
      'bad-part',
      `${what} is not base64url; copy the link again`
    )
  return bytes
}

/**
 * The text form of an Access key: `fak1_` and the base64url of the 32-byte
 * private key.
 *
 * @param key - T's private key.
 * @throws {ShareLinkError} `wrong-access-key` for a key {@link parseAccessKey} would refuse, naming no part of it.
 */
export function accessKeyText(key: Hex): string {
  if (accountOf(key) == null)
    throw new ShareLinkError(
      'wrong-access-key',
      'The Access key is not a valid key: 0x and 64 hex digits, not zero'
    )
  return `${ACCESS_KEY_PREFIX}${toBase64url(hexToBytes(key))}`
}

/**
 * Read an Access key, refusing a Grant or a share link pasted in its place.
 *
 * @param text - The Access key as pasted.
 * @throws {ShareLinkError} Naming what the text is instead, or that it is incomplete.
 */
export function parseAccessKey(text: string): Hex {
  const clean = text.replace(/\s+/g, '')
  if (clean.startsWith(GRANT_PREFIX)) {
    throw new ShareLinkError(
      'grant-pasted',
      'That is a group key Grant (fgr1_…), not an Access key (fak1_…)'
    )
  }
  if (clean.includes(`#${SHARE_FRAGMENT_PREFIX}`)) {
    throw new ShareLinkError(
      'share-link-pasted',
      'That is a share link, not an Access key (fak1_…)'
    )
  }
  if (!clean.startsWith(ACCESS_KEY_PREFIX))
    throw new ShareLinkError(
      'not-an-access-key',
      'An Access key starts with fak1_'
    )
  const body = clean.slice(ACCESS_KEY_PREFIX.length)
  const bytes = body === '' ? new Uint8Array(0) : unb64(body, 'The Access key')
  if (bytes.length !== 32)
    throw new ShareLinkError(
      'incomplete',
      'The Access key is incomplete; copy it again'
    )
  const key = bytesToHex(bytes)
  try {
    publicKeyOf(key)
  } catch {
    throw new ShareLinkError(
      'wrong-access-key',
      'The Access key is not a valid key; copy it again'
    )
  }
  return key
}

/**
 * `<viewer>#v1/<rootCid>&d=<payload>`, then `&k=` for an open link. A fragment
 * already on `viewer` is dropped. The root is written as CIDv1 in base32, the
 * only form {@link parseShareLink} and the viewer read, so a CIDv0 root works
 * too.
 *
 * @param viewer - The viewer's URL.
 * @param rootCid - The encrypted root CID.
 * @param payload - The piece Grant's CBOR.
 * @param accessKey - T's private key, for an open link.
 * @throws {ShareLinkError} `bad-part` when the link would be one the viewer can't read: an empty payload, a payload over 8,192 characters, or a root CID too long. `wrong-access-key` for an Access key that isn't `0x` and 64 hex digits of a valid secp256k1 key.
 */
export function formatShareLink(
  viewer: string,
  rootCid: CID,
  payload: Uint8Array,
  accessKey?: Hex
): string {
  const base = viewer.split('#')[0] ?? viewer
  if (payload.length === 0)
    throw new ShareLinkError('bad-part', 'The share payload is empty')
  let fragment = `${SHARE_FRAGMENT_PREFIX}${rootCid.toV1().toString()}&d=${toBase64url(payload)}`
  if (accessKey != null) {
    // accessKeyText runs the checks a reader runs: 32 bytes, and a valid secp256k1 key.
    fragment += `&k=${accessKeyText(accessKey)}`
  }
  // Every link this writes must parse: here and in the viewer.
  if (!FRAGMENT.test(fragment)) {
    throw new ShareLinkError(
      'bad-part',
      `The share can't be written as a link the viewer reads: its payload is over ${MAX_PAYLOAD_CHARS} characters, or its root CID is too long`
    )
  }
  return `${base}#${fragment}`
}

/**
 * Read a share link, refusing an Access key or a Grant pasted in its place.
 * Whitespace is removed first. The fragment must be exactly what
 * {@link formatShareLink} writes: `v1/`, a base32 CID, `d=`, then `k=` for an
 * open link, in that order, each value canonical base64url, `d` at most
 * 8,192 characters, and `k` a valid secp256k1 private key.
 *
 * @param text - The link as pasted.
 * @throws {ShareLinkError} `access-key-pasted`, `grant-pasted`, `not-a-share-link`, `bad-cid`, `incomplete`, `bad-part`, or an Access key code. Messages never echo the link.
 */
export function parseShareLink(text: string): ParsedShare {
  const clean = text.replace(/\s+/g, '')
  if (clean.startsWith(ACCESS_KEY_PREFIX)) {
    throw new ShareLinkError(
      'access-key-pasted',
      'That is an Access key, not a share link'
    )
  }
  if (clean.startsWith(GRANT_PREFIX)) {
    throw new ShareLinkError(
      'grant-pasted',
      'That is a group key Grant (fgr1_…), not a share link'
    )
  }
  const fragment = clean.slice(clean.indexOf('#') + 1)
  if (!clean.includes('#') || !fragment.startsWith(SHARE_FRAGMENT_PREFIX)) {
    throw new ShareLinkError(
      'not-a-share-link',
      'Not a v1 share link: expected <viewer>#v1/<CID>&d=…'
    )
  }
  const match = FRAGMENT.exec(fragment)
  if (match == null) {
    const [cidText, ...rest] = fragment
      .slice(SHARE_FRAGMENT_PREFIX.length)
      .split('&')
    if (!/^b[a-z2-7]{20,120}$/.test(cidText ?? '')) {
      throw new ShareLinkError(
        'bad-cid',
        'The share link names no valid CID; copy it again'
      )
    }
    if (!rest.some((part) => part.startsWith('d=') && part !== 'd=')) {
      throw new ShareLinkError(
        'incomplete',
        'The share link is incomplete (no share in it); copy it again'
      )
    }
    throw new ShareLinkError(
      'bad-part',
      // Never echo the part: with its `=` lost, an Access key reads as a part's name.
      `The share link has an unexpected, repeated, or damaged part, or a share over ${MAX_PAYLOAD_CHARS} characters; copy it again`
    )
  }
  const [, cidText, d, k] = match
  let rootCid: CID
  try {
    rootCid = CID.parse(cidText ?? '')
  } catch {
    throw new ShareLinkError(
      'bad-cid',
      'The share link names no valid CID; copy it again'
    )
  }
  return {
    rootCid,
    payload: unb64(d ?? '', 'The share'),
    ...(k != null && { accessKey: parseAccessKey(k) }),
  }
}

/** What {@link createShare} needs. */
export interface CreateShareInput {
  /** The sender's credentials: the owner wallet, or a session key's Grants. */
  sender: Credentials
  /** The encrypted root CID. */
  rootCid: CID
  /** The upload's envelope labels: they name its owner, group key, and salt. */
  labels: PieceMetadata
  /** Whether the link carries its Access key. */
  mode: ShareMode
  /** The viewer's URL. Defaults to {@link DEFAULT_VIEWER_URL}. */
  viewer?: string | undefined
}

/** A share link, and its Access key for a restricted link. */
export interface CreatedShare {
  /** The link. An open link carries T's private key in its fragment. */
  link: string
  /** The Access key to send by another channel (restricted mode only). */
  accessKey?: string
}

/**
 * Make a share link for one upload, wrapped to a fresh key T. Read `labels`
 * from the upload's header with `readEnvelopeHeader`, after checking its
 * blocks against their CIDs: a dishonest gateway could return another
 * upload's header. Every key it derives or opens is zeroed before it returns.
 *
 * @param input - The sender, the upload, and the mode.
 * @throws {NotOwnerError} When the sender holds no key for the upload.
 * @throws {GrantError} When no Grant reaches the upload's group.
 * @throws {EncryptionError} `bad-address` for an owner address that isn't one, before the wallet is asked to sign. `share-failed`, naming only an error code, with the original as `cause`, when the wallet refuses to sign or Keysmith refuses a key.
 */
export async function createShare(
  input: CreateShareInput
): Promise<CreatedShare> {
  const { labels, sender } = input
  const view = readLabels(labels)
  if ('owner' in sender) checkAddress(sender.owner.address, 'owner')
  const T = generatePrivateKey()
  let payload: Uint8Array
  try {
    payload = await sharePayload(input, view, T)
  } catch (error) {
    // A wallet that refused to sign, or a key Keysmith refused, has no code of its own.
    if (error instanceof EncryptionError) throw error
    throw new EncryptionError(
      'share-failed',
      `Creating the share failed: ${errorCode(error)}`,
      { cause: error }
    )
  }

  const viewer = input.viewer ?? DEFAULT_VIEWER_URL
  if (input.mode === 'open')
    return { link: formatShareLink(viewer, input.rootCid, payload, T) }
  return {
    link: formatShareLink(viewer, input.rootCid, payload),
    accessKey: accessKeyText(T),
  }
}

/** Whether `node` is a Grant node as Keysmith writes it, such as `piece:0x` and 32 hex digits. */
function isCanonicalNode(node: string): boolean {
  try {
    return canonicalNode(node) === node
  } catch {
    return false
  }
}

/** The share's payload: the upload's piece key, derived from the sender's credentials, wrapped to T. Every key is zeroed before it returns. */
async function sharePayload(
  input: CreateShareInput,
  view: ReturnType<typeof readLabels>,
  T: Hex
): Promise<Uint8Array> {
  const { labels, sender } = input
  let pieceKey: Uint8Array
  let owner: Address
  if ('owner' in sender) {
    owner = sender.owner.address
    // `foc/own` is optional in Keysmith: without it, the upload is read as the sender's, as filecoin-pin's createShare reads it.
    if (view.owner != null && !sameAddress(view.owner, owner)) {
      throw new NotOwnerError(
        view.owner,
        view.groupKeyId,
        `the owner wallet in use is ${owner.toLowerCase()}`
      )
    }
    const { groupKey } = await deriveGroupKey(sender.owner, {
      owner,
      groupKeyId: view.groupKeyId,
    })
    try {
      pieceKey = keyForEnvelope(groupKey, labels)
    } finally {
      groupKey.fill(0)
    }
  } else {
    const grants = await openSessionGrants(sender.session)
    try {
      const picked = grantForPiece(grants, labels, sender.session)
      owner = picked.owner
      pieceKey = keyForEnvelope(picked.key, labels, picked.grant)
    } finally {
      for (const g of grants) g.key.fill(0)
    }
  }
  try {
    const ref = { owner: view.owner ?? owner, groupKeyId: view.groupKeyId }
    return encodeGrant(
      await wrapTo(
        publicKeyOf(T),
        pieceKey,
        grantDescriptor(ref, pieceNode(labels))
      )
    )
  } finally {
    pieceKey.fill(0)
  }
}

/**
 * T's private key for a parsed share: from the link, else the Access key sent
 * with it.
 *
 * @param share - The parsed link.
 * @param accessKey - The Access key, for a restricted link.
 * @throws {ShareLinkError} `needs-access-key` for a restricted link without one.
 */
export function shareKey(
  share: ParsedShare,
  accessKey: string | undefined
): Hex {
  if (share.accessKey != null) return share.accessKey
  if (accessKey == null)
    throw new ShareLinkError(
      'needs-access-key',
      'This share link needs its Access key (fak1_…)'
    )
  return parseAccessKey(accessKey)
}

/** CBOR major type of a payload's first byte: an array is a Delivery, a map a plain piece Grant. */
const DELIVERY = 4
const GRANT = 5

const damaged = (message: string): ShareLinkError =>
  new ShareLinkError('damaged-link', `${message}; copy the link again`)

/** Keysmith's refusal to check a link that narrows a group to a piece without the piece's labels. */
const NEEDS_LABELS = "checking it needs the piece's labels"

const wrongAccessKey = (): ShareLinkError =>
  new ShareLinkError(
    'wrong-access-key',
    'The Access key does not open this share'
  )

const expired = (expires: number): ShareLinkError =>
  new ShareLinkError(
    'share-expired',
    `The share expired at ${expiryText(expires)}; ask its sender for a new link`
  )

/** Keysmith's refusal of a link wider than its parent, after that link's signature and depth checks. */
const WIDENS = /^Link (\d+) widens /

/**
 * The labels of the piece a chain names, when Keysmith refused it as wider
 * than its parent only because it was checked against another upload. The
 * refused link must step to a piece, from a group or from that same piece,
 * and the chain must end at that piece. The labels take the salt from that
 * piece and the group from the group link above it. A step to a wider group,
 * or from one piece to another, is wrong for every upload: undefined.
 */
function claimedPiece(
  chain: ClaimChain,
  message: string
): PieceMetadata | undefined {
  const index = Number(WIDENS.exec(message)?.[1])
  const parent = chain.links[index - 1]
  const child = chain.links[index]
  if (parent == null || child == null) return undefined
  if (!child.node.startsWith('piece:')) return undefined
  if (parent.node.startsWith('piece:') && parent.node !== child.node)
    return undefined
  if (chain.links.at(-1)?.node !== child.node) return undefined
  const first = chain.links.findIndex((link) => link.node.startsWith('piece:'))
  const above = chain.links[first - 1]?.node
  try {
    return pieceMetadata(
      { owner: chain.owner, groupKeyId: chain.groupKeyId },
      {
        salt: child.node.slice('piece:'.length) as Hex,
        ...(above?.startsWith('group:') === true && {
          group: above.slice('group:'.length),
        }),
      }
    )
  } catch {
    return undefined
  }
}

/**
 * Whether a Delivery opens in full for `labels`: every signature, the
 * wrapped key, and its commitment. Only to classify an error: the key it
 * opens is zeroed, never returned.
 */
async function opensFor(
  T: Hex,
  payload: Uint8Array,
  labels: PieceMetadata
): Promise<boolean> {
  try {
    ;(await openDelivery(T, payload, { piece: labels })).key.fill(0)
    return true
  } catch {
    return false
  }
}

/**
 * Check a Delivery's bearer and expiry before anything else, so a wrong
 * Access key or an expired share says so, whatever upload it is checked
 * against. Unverified: `openDelivery` checks both again with the signatures.
 */
function checkBearer(chain: ClaimChain, T: Hex): void {
  const bearer = chain.links.at(-1)?.bearer
  let address: Address
  try {
    address = privateKeyToAccount(T).address
  } catch {
    // T is out of the curve's range, as an all-zero key is.
    throw wrongAccessKey()
  }
  if (bearer == null || !sameAddress(bearer, address)) throw wrongAccessKey()
  if (chain.expires <= Math.floor(Date.now() / 1000))
    throw expired(chain.expires)
}

/**
 * Open a share's payload with T: the shared key and the Grant that names its
 * owner, group key, and node. It checks in the order filecoin-pin and the
 * viewer do: T opens the payload, a Delivery hasn't expired, and only then
 * that the share is for this upload, `piece`, when given. A Delivery's chain
 * must verify before it can be refused as another upload's, so a damaged
 * Delivery is `damaged-link` whatever upload it is checked against. A chain
 * with a link that narrows a group to the piece
 * verifies only with the piece's labels: without them, this returns
 * undefined.
 */
async function openPayload(
  share: ParsedShare,
  T: Hex,
  piece?: PieceMetadata
): Promise<{ key: Uint8Array; grant: Grant } | undefined> {
  const kind = (share.payload[0] ?? 0) >> 5
  let grant: Grant
  let chain: ClaimChain | undefined
  try {
    if (kind === DELIVERY) ({ chain, grant } = decodeDelivery(share.payload))
    else if (kind === GRANT) grant = decodeGrant(share.payload)
    else throw new Error('Neither a Delivery nor a Grant')
  } catch (error) {
    // A link from filecoin-pin 2.3 or 2.4 is whole, in a format this version no longer reads.
    const format1 = format1Message(error)
    if (format1 != null) throw new ShareLinkError('format-1', format1)
    throw damaged('The share is not a Keysmith Grant or Delivery')
  }
  // A Grant for a group key or a group opens more than one upload: a share never carries one.
  if (!grant.node.startsWith('piece:'))
    throw damaged('The share is for more than one upload')
  // Keysmith's decodeGrant reads any node text, and unwrapWith refuses a malformed one before it tries the key.
  if (!isCanonicalNode(grant.node))
    throw damaged('The share does not name an upload')
  const otherUpload = (): ShareLinkError =>
    new ShareLinkError('other-upload', 'This share is for another upload')

  if (chain == null) {
    let key: Uint8Array
    try {
      key = await unwrapWith(T, grant)
    } catch {
      throw wrongAccessKey()
    }
    if (piece != null && grant.node !== pieceNode(piece)) {
      key.fill(0)
      throw otherUpload()
    }
    return { key, grant }
  }
  checkBearer(chain, T)
  let opened: Awaited<ReturnType<typeof openDelivery>>
  try {
    opened = await openDelivery(
      T,
      share.payload,
      piece == null ? {} : { piece }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'This delivery is for another bearer')
      throw wrongAccessKey()
    if (piece == null && message.endsWith(NEEDS_LABELS)) return undefined
    // Another upload only if the Delivery verifies in full for the piece it names, so a damaged one is damaged for every upload.
    const claimed = piece == null ? undefined : claimedPiece(chain, message)
    if (claimed != null && (await opensFor(T, share.payload, claimed)))
      throw otherUpload()
    throw damaged('The share does not verify')
  }
  // A link from a group key to a piece is checked against no piece's labels.
  if (piece != null && opened.grant.node !== pieceNode(piece)) {
    opened.key.fill(0)
    throw otherUpload()
  }
  // Keysmith opens an expired chain and says so; a share's expiry is what its sender set, so it is refused.
  if (opened.expired) {
    opened.key.fill(0)
    throw expired(opened.chain.expires)
  }
  return { key: opened.key, grant: opened.grant }
}

/**
 * The wallet the shared upload belongs to, as the share's Grant names it, so a
 * reader can look for providers among that wallet's data sets. Opening the
 * payload also checks T before any download.
 *
 * A Delivery that a group's Grant narrowed to the piece verifies only once
 * the envelope's labels are known. For one, this checks only that T is its
 * bearer and that it hasn't expired, and returns the owner its chain names,
 * unverified: {@link shareKeyResolver} verifies the whole chain before it
 * returns a key. The share link viewer can't open such a Delivery yet.
 *
 * @param share - The parsed link.
 * @param T - T's private key, from {@link shareKey}.
 */
export async function shareOwner(share: ParsedShare, T: Hex): Promise<Address> {
  const opened = await openPayload(share, T)
  if (opened != null) {
    opened.key.fill(0)
    return getAddress(opened.grant.owner)
  }
  // openPayload returns undefined only for a Delivery whose bearer and expiry it checked.
  return getAddress(decodeDelivery(share.payload).chain.owner)
}

/**
 * A FEE key resolver for a share: it checks the envelope's labels, opens the
 * payload with T, checking a Delivery's whole chain against them, and derives
 * the upload's key, checking the envelope's owner, group key, and salt
 * against the share.
 *
 * The function it returns hands the envelope's piece key to its caller.
 * `decrypt` and `decryptToSink` zero that key when their stream ends. A
 * caller that calls the function itself owns the key and must zero it. For a
 * range read, call it with the info from FEE's `parse`, pass the key to FEE's
 * `decryptRange`, and zero it in a `finally` once that call settles: FEE
 * imports the key before `decryptRange` resolves.
 *
 * @param share - The parsed link.
 * @param T - T's private key, from {@link shareKey}.
 */
export function shareKeyResolver(share: ParsedShare, T: Hex): KeyResolver {
  return async ({ appMetadata }) => {
    // A format 1 or unlabeled envelope isn't another upload: it is one this version can't read.
    readLabels(appMetadata)
    const opened = await openPayload(
      share,
      T,
      appMetadata as unknown as PieceMetadata
    )
    if (opened == null) throw damaged('The share does not verify')
    const { key, grant } = opened
    try {
      return keyForEnvelope(key, appMetadata, grant)
    } catch (error) {
      throw new ShareLinkError(
        'other-upload',
        `This share is for another upload: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      key.fill(0)
    }
  }
}

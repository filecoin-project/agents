/**
 * Credentials and key resolution: where a writer's piece key comes from, and
 * how a reader's FEE key resolver finds the key an envelope needs.
 *
 * A client holds a key in one of two ways:
 *
 * - **Owner mode.** The owner wallet signs Keysmith's `GroupKey` message, and
 *   every key derives from that signature.
 * - **Session-key mode.** A session key can't sign for the owner, so it holds
 *   Grants (`fgr1_…`) that wrap a group key or a group's key to it.
 *
 * No function here returns an unwrapped group key or Grant key: each is
 * zeroed as soon as the piece key is derived. The key resolvers return a
 * piece key to whoever calls them, which is FEE inside `decrypt`.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/group-key.ts
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/group-key-grant.ts
 * @module
 */

import {
  deriveGroupKey,
  keyForEnvelope,
  newSalt,
  type PieceLabels,
  type PieceMetadata,
  pickGrant,
  pieceKey,
  pieceMetadata,
  writeTarget,
} from '@filoz/keysmith'
import type { KeyResolver } from 'filecoin-encryption-envelope'
import type { Address, Hex } from 'viem'
import {
  DecryptError,
  EncryptionError,
  errorCode,
  GrantError,
  NotOwnerError,
} from './errors.ts'
import { type GrantExpectations, grantCovers, splitGrants } from './grant.ts'
import {
  COMMITMENT_KEY,
  checkAddress,
  checkGroup,
  chooseGroupKey,
  type DataSetInfo,
  ENCRYPTION_VERSION,
  ENCRYPTION_VERSION_KEY,
  encryptedDataSetMetadata,
  format1Message,
  GROUP_KEY_ID_KEY,
  type OwnerSigner,
  type SkippedGroupKey,
} from './group-key.ts'
import { sameAddress } from './internal/bytes.ts'
import { readLabels } from './internal/labels.ts'
import {
  checkExpectations,
  type OpenedGrant,
  openGrantWithKey,
} from './internal/opened-grant.ts'

/** A session key and the Grants it holds, as a client stores them. */
export interface SessionCredentials {
  /** The session key's private key. */
  sessionKey: Hex
  /** The owner wallet that authorized the session key. */
  walletAddress: Address
  /** The network's chain id. Undefined skips the network check, for an offline read. */
  chainId?: number | bigint | undefined
  /** The saved group key id that every Grant must be for. */
  groupKeyId: string
  /** The saved Grant texts, or one comma-joined string of them. */
  grants: readonly string[] | string
  /** Unix seconds, for tests. */
  now?: number | undefined
  /**
   * Called for each Grant that no longer opens (one group's Grant expired, say),
   * when another still does. Only when none opens is that an error.
   */
  onIgnored?: ((error: GrantError) => void) | undefined
}

/** What a client holds a key with: the owner wallet, or a session key with Grants. */
export type Credentials =
  | { owner: OwnerSigner }
  | { session: SessionCredentials }

/**
 * Open every Grant a session holds. A Grant that fails a check is skipped and
 * reported to `onIgnored`, unless none opens.
 *
 * @internal
 * @throws {GrantError} `no-grant`, or the reasons every Grant was refused.
 */
export async function openSessionGrants(
  session: SessionCredentials
): Promise<OpenedGrant[]> {
  const texts =
    typeof session.grants === 'string'
      ? splitGrants(session.grants)
      : session.grants
  if (texts.length === 0)
    throw new GrantError('no-grant', 'This session key has no group key Grant.')
  const expected: GrantExpectations = {
    sessionKey: session.sessionKey,
    walletAddress: session.walletAddress,
    chainId: session.chainId,
    groupKeyId: session.groupKeyId,
    now: session.now,
  }
  // The session's own values are checked once, not once per Grant.
  checkExpectations(expected)
  const opened: OpenedGrant[] = []
  const ignored: GrantError[] = []
  for (const text of texts) {
    try {
      opened.push(await openGrantWithKey(text, expected))
    } catch (error) {
      if (!(error instanceof GrantError)) {
        wipe(opened)
        throw error
      }
      ignored.push(error)
    }
  }
  const [first] = ignored
  if (opened.length === 0 && first != null) {
    if (ignored.length === 1) throw first
    throw new GrantError(
      first.code,
      `Every Grant was refused: ${ignored.map((e) => e.message).join(' ')}`
    )
  }
  try {
    for (const error of ignored) session.onIgnored?.(error)
  } catch (error) {
    // The caller never gets the keys to wipe: wipe them here.
    wipe(opened)
    throw error
  }
  return opened
}

/** Zero every opened Grant's key. */
const wipe = (grants: readonly OpenedGrant[]): void => {
  for (const g of grants) g.key.fill(0)
}

/** What Grant selection checks a held Grant against: the network and the time. */
export interface PickOptions {
  /** The session's chain id. Undefined considers the Grants of every network the session holds. */
  chainId?: number | bigint | undefined
  /** Unix seconds. Defaults to now. */
  now?: number | undefined
}

/** How narrow a Grant is: deeper groups first, the whole group key last. */
const depthOf = (g: OpenedGrant): number =>
  g.group == null ? 0 : g.group.split('/').length

/**
 * Keysmith's `pickGrant` over the session's network, or over each network it
 * holds Grants for when the session names none. Across networks, the narrowest
 * pick wins, and on a tie the one that expires last.
 */
function pickAcross(
  grants: readonly OpenedGrant[],
  target: Parameters<typeof pickGrant>[1],
  options: PickOptions,
  owner?: Address
): OpenedGrant | undefined {
  const chains =
    options.chainId == null
      ? [...new Set(grants.map((g) => g.claim.chainId))]
      : [BigInt(options.chainId)]
  let best: OpenedGrant | undefined
  for (const chainId of chains) {
    const picked = pickGrant(grants, target, {
      chainId,
      ...(options.now != null && { now: options.now }),
      ...(owner != null && { owner }),
    })
    if (
      picked != null &&
      (best == null ||
        depthOf(picked) > depthOf(best) ||
        (depthOf(picked) === depthOf(best) &&
          picked.claim.expires > best.claim.expires))
    ) {
      best = picked
    }
  }
  return best
}

/** The Grant of `grants` that expires last. */
const latest = (grants: readonly OpenedGrant[]): OpenedGrant | undefined =>
  grants.reduce<OpenedGrant | undefined>(
    (best, g) =>
      best == null || g.claim.expires > best.claim.expires ? g : best,
    undefined
  )

/**
 * The Grant a session key writes `group` with (undefined: the Grant's own
 * group): the narrowest one that covers it. With no group named, every Grant
 * must be for one group, or one must be for the whole group key; of those,
 * the one that expires last. Else the caller must choose.
 *
 * @internal
 * @throws {GrantError} `no-grant-for-group` or `ambiguous-group`.
 */
export function grantForWrite(
  grants: readonly OpenedGrant[],
  group: string | undefined,
  options: PickOptions = {}
): OpenedGrant {
  const [first] = grants
  if (first == null)
    throw new GrantError('no-grant', 'This session key has no group key Grant.')
  if (group == null) {
    const groups = new Set(grants.map((g) => g.group))
    const whole = latest(grants.filter((g) => g.group == null))
    const only = groups.size === 1 ? latest(grants) : undefined
    const picked = whole ?? only
    if (picked != null) return picked
    throw new GrantError(
      'ambiguous-group',
      `This session key holds Grants for several groups (${[...groups].join(', ')}): choose one.`
    )
  }
  const picked = pickAcross(
    grants,
    { owner: first.owner, groupKeyId: first.groupKeyId, group },
    options
  )
  if (picked == null) {
    throw new GrantError(
      'no-grant-for-group',
      `None of this session key's Grants covers group ${group} (held: ${grants.map(grantCovers).join('; ')}).`
    )
  }
  return picked
}

/**
 * The Grant that opens a piece with these envelope labels: Keysmith's
 * `pickGrant`, the narrowest one that reaches the piece's group.
 *
 * @internal
 * @throws {DecryptError} `not-encrypted` or `format-1` for labels this version doesn't read.
 * @throws {NotOwnerError} For another owner or group key.
 * @throws {GrantError} `no-grant-for-group` when the piece is outside every held group.
 */
export function grantForPiece(
  grants: readonly OpenedGrant[],
  appMetadata: unknown,
  options: PickOptions = {}
): OpenedGrant {
  const labels = readLabels(appMetadata)
  const [first] = grants
  if (first == null)
    throw new GrantError('no-grant', 'This session key has no group key Grant.')
  const owner = labels.owner ?? first.owner
  if (
    !sameAddress(owner, first.owner) ||
    labels.groupKeyId !== first.groupKeyId
  ) {
    throw new NotOwnerError(
      owner,
      labels.groupKeyId,
      `this session's Grants are for group key ${first.groupKeyId} of ${first.owner.toLowerCase()}`
    )
  }
  const picked = pickAcross(
    grants,
    { piece: appMetadata as PieceLabels },
    options,
    first.owner
  )
  if (picked == null) {
    const where =
      labels.group == null
        ? 'at the group key root (no group)'
        : `in group ${labels.group}`
    throw new GrantError(
      'no-grant-for-group',
      `This upload is ${where}, outside every group this session key holds a Grant for (${grants.map(grantCovers).join('; ')}).`
    )
  }
  return picked
}

/** What a write needs to pick its group key. */
export interface WriteKeyOptions {
  /** The owner wallet, or a session key with Grants. */
  credentials: Credentials
  /**
   * The owner's data sets, as the caller lists them. Owner mode picks the
   * oldest valid group key among them. Session-key mode checks that the
   * Grant's group key agrees with them.
   */
  dataSets: readonly DataSetInfo[]
  /** A group to write under, checked with `checkGroup` before any signature. Undefined writes at the Grant's or the group key's root. */
  group?: string | undefined
  /** Called for each group key the owner-mode choice skips. */
  onSkip?: ((skipped: SkippedGroupKey) => void) | undefined
}

/**
 * A fresh piece key for one upload. Internal: only the FEE stream sees `cek`.
 *
 * @internal
 */
export interface NewPieceKey {
  /** The piece key. Zero it once the stream that borrows it is done. */
  cek: Uint8Array
  /** The envelope's labels (`foc/v`, `foc/own`, `foc/gkid`, `foc/group`, `foc/salt`). */
  labels: PieceMetadata
  /** `foc/enc`, `foc/gkid`, and `foc/kc`, for every data set the upload is written to. */
  dataSetMetadata: Record<string, string>
}

/**
 * Derive a fresh piece key, under a fresh salt, for one upload. The group key
 * or Grant key it derives from is zeroed before this returns.
 *
 * @internal
 * @throws {GrantError} `chain-disagrees` when live data sets of the Grant's group key record another commitment or another `foc/enc`.
 */
export async function newPieceKey(
  options: WriteKeyOptions
): Promise<NewPieceKey> {
  const { credentials } = options
  // Before any wallet prompt, so a bad group fails as `bad-group` with no signature asked for.
  const group = options.group == null ? undefined : checkGroup(options.group)
  if ('owner' in credentials) {
    const signer = credentials.owner
    checkAddress(signer.address, 'owner')
    const choice = chooseGroupKey(
      signer.address,
      options.dataSets,
      options.onSkip
    )
    const ref = { owner: signer.address, groupKeyId: choice.groupKeyId }
    const keys = await deriveGroupKey(
      signer,
      ref,
      choice.commitment == null ? {} : { commitment: choice.commitment }
    )
    try {
      // Inside the try: an invalid group throws here, and the group key must still be zeroed.
      const target = writeTarget(keys.descriptor, keys.groupKey, group)
      try {
        return pieceKeyFor(
          target,
          encryptedDataSetMetadata(ref, keys.commitment)
        )
      } finally {
        target.key.fill(0)
      }
    } finally {
      keys.groupKey.fill(0)
    }
  }
  const { session } = credentials
  const grants = await openSessionGrants(session)
  try {
    const opened = grantForWrite(grants, group, session)
    const disagreeing = options.dataSets.filter(
      (dataSet) =>
        dataSet.isLive !== false &&
        // Exact match, as in validGroupKeys: a non-canonical lookalike id is another group key, ignored.
        dataSet.metadata[GROUP_KEY_ID_KEY] === opened.groupKeyId &&
        (dataSet.metadata[COMMITMENT_KEY] !== opened.commitment ||
          dataSet.metadata[ENCRYPTION_VERSION_KEY] !== ENCRYPTION_VERSION)
    )
    if (disagreeing.length > 0) {
      throw new GrantError(
        'chain-disagrees',
        `Group key ${opened.groupKeyId} is used by data sets ${disagreeing.map((d) => d.dataSetId).join(', ')}, which disagree with the Grant on foc/kc or are not foc/enc "1".`
      )
    }
    const target = writeTarget(opened.grant, opened.key, group)
    try {
      return pieceKeyFor(
        target,
        encryptedDataSetMetadata(opened, opened.commitment)
      )
    } finally {
      target.key.fill(0)
    }
  } finally {
    wipe(grants)
  }
}

/** A piece key under a fresh salt below `target`, and the labels that name it. */
function pieceKeyFor(
  target: ReturnType<typeof writeTarget>,
  dataSetMetadata: Record<string, string>
): NewPieceKey {
  const salt = newSalt()
  return {
    cek: pieceKey(target.key, salt),
    labels: pieceMetadata(target.ref, {
      salt,
      ...(target.group != null && { group: target.group }),
    }),
    dataSetMetadata,
  }
}

/**
 * A FEE key resolver for the owner wallet: signs for the group key the
 * envelope names and derives the piece key from its labels. It signs twice,
 * because there is no data set commitment to check against offline.
 *
 * `signer` may be a getter, called only once an envelope needs a key, so a
 * caller that may never meet one (`get` on plain content) needs no wallet. A
 * getter that returns undefined fails with a {@link NotOwnerError} that names
 * the envelope's owner and group key.
 *
 * The function it returns hands the envelope's piece key to its caller.
 * `decrypt` and `decryptToSink` zero that key when their stream ends. A
 * caller that calls the function itself owns the key and must zero it. For a
 * range read, call it with the info from FEE's `parse`, pass the key to FEE's
 * `decryptRange`, and zero it in a `finally` once that call settles: FEE
 * imports the key before `decryptRange` resolves.
 *
 * @param signer - The owner wallet, or a getter for it.
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/group-key.ts
 */
export function ownerKeyResolver(
  signer: OwnerSigner | (() => OwnerSigner | undefined)
): KeyResolver {
  return async ({ appMetadata }) => {
    const labels = readLabels(appMetadata)
    const { groupKeyId } = labels
    const wallet = typeof signer === 'function' ? signer() : signer
    // Before a not-owner message could repeat it: a private key pasted for the address must not land there.
    if (wallet != null) checkAddress(wallet.address, 'owner')
    // `foc/own` is optional in Keysmith: without it, the upload is read as the wallet's, as session mode and `createShare` read it. filecoin-pin's owner resolver refuses it instead.
    const owner = labels.owner ?? wallet?.address
    if (
      wallet == null ||
      owner == null ||
      !sameAddress(owner, wallet.address)
    ) {
      throw new NotOwnerError(
        owner ?? 'an unnamed owner',
        groupKeyId,
        wallet == null
          ? undefined
          : `the owner wallet in use is ${wallet.address.toLowerCase()}`
      )
    }
    let groupKey: Uint8Array
    try {
      ;({ groupKey } = await deriveGroupKey(wallet, {
        owner: wallet.address,
        groupKeyId,
      }))
    } catch (error) {
      throw resolverError(error)
    }
    try {
      return keyForEnvelope(groupKey, appMetadata)
    } catch (error) {
      throw resolverError(error)
    } finally {
      groupKey.fill(0)
    }
  }
}

/**
 * A resolver's failure as a coded error, for a caller that calls the resolver
 * itself: this package's own errors as they are, Keysmith's format 1 refusal
 * as `format-1`, and anything else, such as a wallet that refused to sign, as
 * `decrypt-failed` with only its code in the message and the original as
 * `cause`.
 *
 * @param error - Any thrown value.
 */
function resolverError(error: unknown): EncryptionError {
  if (error instanceof EncryptionError) return error
  const format1 = format1Message(error)
  if (format1 != null) return new DecryptError('format-1', format1)
  return new DecryptError(
    'decrypt-failed',
    `Decryption failed: ${errorCode(error)}`,
    { cause: error }
  )
}

/**
 * A FEE key resolver for a session key's Grants. The Grants are opened only
 * when an envelope needs a key, so plain content needs none, and every key
 * they open is zeroed once the piece key is derived. An envelope of another
 * owner or group key fails with a {@link NotOwnerError} naming both; one
 * outside every held group fails with a {@link GrantError}.
 *
 * The function it returns hands the envelope's piece key to its caller.
 * `decrypt` and `decryptToSink` zero that key when their stream ends. A
 * caller that calls the function itself owns the key and must zero it. For a
 * range read, call it with the info from FEE's `parse`, pass the key to FEE's
 * `decryptRange`, and zero it in a `finally` once that call settles: FEE
 * imports the key before `decryptRange` resolves.
 *
 * @param session - The session's credentials, or a getter for them.
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/group-key-grant.ts
 */
export function grantKeyResolver(
  session:
    | SessionCredentials
    | (() => SessionCredentials | Promise<SessionCredentials>)
): KeyResolver {
  return async ({ appMetadata }) => {
    // Refuses anything but a format 2 Keysmith envelope before a Grant is opened.
    readLabels(appMetadata)
    const held = typeof session === 'function' ? await session() : session
    const grants = await openSessionGrants(held)
    try {
      const picked = grantForPiece(grants, appMetadata, held)
      return keyForEnvelope(picked.key, appMetadata, picked.grant)
    } catch (error) {
      throw resolverError(error)
    } finally {
      wipe(grants)
    }
  }
}

/**
 * The key resolver for a client's credentials: the owner wallet, else a
 * session key's Grants. With none, an envelope fails with a
 * {@link NotOwnerError} naming its owner and group key. Nothing is signed or
 * opened until an envelope needs a key.
 *
 * The function it returns hands the envelope's piece key to its caller.
 * `decrypt` and `decryptToSink` zero that key when their stream ends. A
 * caller that calls the function itself owns the key and must zero it. For a
 * range read, call it with the info from FEE's `parse`, pass the key to FEE's
 * `decryptRange`, and zero it in a `finally` once that call settles: FEE
 * imports the key before `decryptRange` resolves.
 *
 * @param credentials - The client's credentials, if any.
 */
export function credentialKeyResolver(
  credentials: Credentials | undefined
): KeyResolver {
  if (credentials == null) return ownerKeyResolver(() => undefined)
  if ('owner' in credentials) return ownerKeyResolver(credentials.owner)
  return grantKeyResolver(credentials.session)
}

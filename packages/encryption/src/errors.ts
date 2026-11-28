/**
 * Errors this package raises. Every message is safe to print: it never holds a
 * plaintext name, path, or CID. It may hold public values, such as an envelope's
 * owner and group key id, a Grant's expiry, or a size.
 *
 * Each error carries a `code`, so a caller can attach its own next step (a
 * login command, say) without parsing the message.
 *
 * @module
 */

/**
 * Base class of every error this package raises. `code` names the failure;
 * the message is safe to print as it is. Its own codes: `bad-address`,
 * `bad-group`, `encrypt-failed`, `issue-failed`, and `share-failed`.
 */
export class EncryptionError extends Error {
  override name = 'EncryptionError'
  /** A stable, kebab-case name for the failure. */
  readonly code: string

  /**
   * @param code - A stable name for the failure.
   * @param message - A message that names nothing from inside an envelope.
   * @param options - The standard error options. A `cause` may hold plaintext names, so never print it.
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/**
 * The credentials hold no key for an envelope, or for the group key a write
 * needs. Codes: `no-credentials`, `not-owner`, and the {@link GrantError} codes.
 */
export class KeyAccessError extends EncryptionError {
  override name = 'KeyAccessError'
}

/**
 * The envelope belongs to another owner or group key than the credentials
 * hold. `owner` and `groupKeyId` are the envelope's public labels. `held`
 * describes what the credentials hold, when they hold anything.
 */
export class NotOwnerError extends KeyAccessError {
  override name = 'NotOwnerError'
  /** The envelope's `foc/own` label. */
  readonly owner: string
  /** The envelope's `foc/gkid` label. */
  readonly groupKeyId: string
  /** What the credentials hold instead, for the message. */
  readonly held: string | undefined

  /**
   * @param owner - The envelope's owner label.
   * @param groupKeyId - The envelope's group key id label.
   * @param held - What the credentials hold instead, if anything.
   */
  constructor(owner: string, groupKeyId: string, held: string | undefined) {
    super(
      held == null ? 'no-credentials' : 'not-owner',
      held == null
        ? `This upload belongs to ${owner} under group key ${groupKeyId}, and no credentials were given`
        : `This upload belongs to ${owner} under group key ${groupKeyId}; ${held}`
    )
    this.owner = owner
    this.groupKeyId = groupKeyId
    this.held = held
  }
}

/**
 * A group key Grant (`fgr1_…`) that failed a check. Codes: `no-grant`,
 * `not-a-grant`, `access-key-pasted`, `share-link-pasted`, `incomplete`,
 * `format-1`, `wrong-session-key`, `expired`, `does-not-verify`, `wrong-owner`,
 * `wrong-network`, `wrong-group-key`, `piece-grant`, `no-grant-for-group`,
 * `ambiguous-group`, `chain-disagrees`, `bad-session-key`, `bad-chain-id`,
 * and, from the console link and Grant issuance, `bad-pubkey`,
 * `bad-pubkeysig`, `old-cli`, `bad-group`, `bad-node`, `bad-maxdepth`,
 * `bad-expires`, `bad-group-key`, `bad-commitment`.
 */
export class GrantError extends KeyAccessError {
  override name = 'GrantError'
}

/**
 * A share link (`#v1/…`) or an Access key (`fak1_…`) that cannot be used.
 * Codes: `not-a-share-link`, `access-key-pasted`, `grant-pasted`,
 * `share-link-pasted`, `not-an-access-key`, `bad-cid`, `bad-part`,
 * `incomplete`, `needs-access-key`, `wrong-access-key`, `other-upload`,
 * `damaged-link`, `share-expired`, `format-1`.
 */
export class ShareLinkError extends KeyAccessError {
  override name = 'ShareLinkError'
}

/**
 * An input to pack that cannot be packed. It names an entry by its 1-based
 * position in the caller's entry list (`entry #3`), never by its path. Codes:
 * `bad-entries`, `unsafe-name`, `unreadable`, `changed`, `too-large`.
 */
export class InputError extends EncryptionError {
  override name = 'InputError'
}

/**
 * An inner CAR that is not a valid metadata-first payload, or is unsafe to
 * unpack. Codes: `bad-version`, `bad-roots`, `not-metadata-first`,
 * `bad-codec`, `bad-hash`, `block-mismatch`, `out-of-order`, `truncated`,
 * `unsafe-name`, `not-unixfs`, `not-one-entry`, `bad-tree`, `layout-limit`.
 */
export class InnerCarError extends EncryptionError {
  override name = 'InnerCarError'
}

/**
 * A decryption that failed. Codes: `wrong-key-or-modified`, `truncated`,
 * `incomplete-download`, `damaged-link`, `not-encrypted`, `format-1`,
 * `malformed-envelope`, `decrypt-failed`, from an archive `archive-closed`
 * and `not-a-file`, and the codes of {@link KeyAccessError} and
 * {@link InnerCarError}, whose messages it keeps.
 */
export class DecryptError extends EncryptionError {
  override name = 'DecryptError'
}

/**
 * No group key is valid, and the owner's default group key id is already on
 * chain, so writing into it would grow an invalid group key. Code
 * `invalid-default-group-key`. `dataSetIds` lists the live data sets that hold
 * the default id: public on-chain values, for a caller to show.
 */
export class GroupKeyChoiceError extends EncryptionError {
  override name = 'GroupKeyChoiceError'
  /** The live data sets that record the default group key id. */
  readonly dataSetIds: readonly bigint[]

  /**
   * @param message - A message that names nothing from inside an envelope.
   * @param dataSetIds - The data sets that record the default group key id.
   */
  constructor(message: string, dataSetIds: readonly bigint[]) {
    super('invalid-default-group-key', message)
    this.dataSetIds = Object.freeze([...dataSetIds])
  }
}

/**
 * The system error codes {@link errorCode} copies: POSIX `errno` names that
 * file and network reads give. A word that only looks like one, such as a
 * file name in capitals, is left out.
 * See {@link https://nodejs.org/api/errors.html#common-system-errors | Node's common system errors}.
 */
const SYSTEM_CODES = new Set([
  'E2BIG',
  'EACCES',
  'EADDRINUSE',
  'EAGAIN',
  'EBADF',
  'EBUSY',
  'ECANCELED',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDQUOT',
  'EEXIST',
  'EFBIG',
  'EHOSTUNREACH',
  'EINTR',
  'EINVAL',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENETDOWN',
  'ENETUNREACH',
  'ENFILE',
  'ENODEV',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'ENOTCONN',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTFOUND',
  'ENOTSUP',
  'ENXIO',
  'EOVERFLOW',
  'EPERM',
  'EPIPE',
  'EROFS',
  'ESPIPE',
  'ESTALE',
  'ETIMEDOUT',
  'ETXTBSY',
  'EWOULDBLOCK',
  'EXDEV',
  'ABORT_ERR',
])
/** Node's own codes: `ERR_` and capitals, as `ERR_INVALID_STATE`. */
const NODE_CODE = /^ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*$/
/** A class name: PascalCase ending in `Error`, as `TypeError` or `AbortError`. Code names a class, not data. */
const SAFE_NAME = /^(?:[A-Z][A-Za-z0-9]*)?Error$/
/** The longest code or class name {@link errorCode} copies. */
const MAX_CODE_LENGTH = 48

/**
 * The `code` of a system error (`EACCES`, `ENOSPC`, …) or Node (`ERR_…`), or
 * else the error's class name, never its message, which may hold a path. Any
 * other code or name, such as a file name or a key, is left out.
 *
 * @param error - Any thrown value.
 */
export function errorCode(error: unknown): string {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown }
  if (
    typeof code === 'string' &&
    (SYSTEM_CODES.has(code) ||
      (code.length <= MAX_CODE_LENGTH && NODE_CODE.test(code)))
  )
    return code
  if (
    typeof name === 'string' &&
    name.length <= MAX_CODE_LENGTH &&
    SAFE_NAME.test(name)
  )
    return name
  return 'unknown error'
}

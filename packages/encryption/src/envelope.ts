/**
 * The envelope: FEE scheme 2 around the inner CAR, as filecoin-pin writes it.
 *
 * - The protected header's `content_type` is `application/vnd.ipld.car`, and
 *   a reader refuses any other value.
 * - `app_metadata` holds Keysmith's piece labels: `foc/v`, `foc/own`,
 *   `foc/gkid`, `foc/group`, `foc/salt`.
 * - `plaintext_length` is always written, so a reader detects truncation.
 * - Chunks are FEE's default 256 KiB.
 * - The envelope is uploaded as one UnixFS file named `encrypted.fee`.
 *
 * Nothing about the plaintext (names, sizes, the root CID) is in the public
 * header. Every error this module raises is safe to print.
 *
 * Ported from filecoin-pin's `src/common/encryption.ts` and
 * `src/common/ipfs-get.ts` on `feat/encryption-v2`.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/encryption.ts
 * @see https://github.com/filecoin-project/FIPs/pull/1294
 * @module
 */

import {
  type PieceMetadata,
  type PieceMetadataView,
  readPieceMetadata,
} from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import {
  emitInnerCar,
  type InnerCarPlan,
  type InputSource,
  type UnpackResult,
  type UnpackSink,
  unpackInnerCar,
} from './car/index.ts'
import { checkUnpackOptions, type UnpackOptions } from './car/unpack.ts'
import {
  DecryptError,
  EncryptionError,
  errorCode,
  InputError,
} from './errors.ts'
import { checkGroup, format1Message } from './group-key.ts'
import { type ByteSource, guarded, toStream } from './internal/bytes.ts'
import { NOT_ENCRYPTED } from './internal/labels.ts'
import { type NewPieceKey, newPieceKey, type WriteKeyOptions } from './keys.ts'

export type { KeyResolver } from 'filecoin-encryption-envelope'
export {
  type Credentials,
  credentialKeyResolver,
  grantKeyResolver,
  ownerKeyResolver,
  type SessionCredentials,
  type WriteKeyOptions,
} from './keys.ts'

/** The envelope's file name in the outer CAR and in piece metadata, so the original name never reaches either. */
export const ENCRYPTED_FILE_NAME = 'encrypted.fee'

/** The envelope's public `content_type`. Readers refuse any other value. */
export const CAR_CONTENT_TYPE = 'application/vnd.ipld.car'

/** FEE scheme 2's plaintext chunk size, as filecoin-pin writes it: 256 KiB. */
export const CHUNK_SIZE: number = fee.constants.DEFAULT_CHUNK_SIZE

/**
 * How many leading bytes of a file to read before {@link readEnvelopeHeader}:
 * FEE caps the envelope at 1 MiB, and filecoin-pin's is about 260 bytes.
 */
export const ENVELOPE_PROBE_BYTES: number = 1024 * 1024

/**
 * The most bytes the envelope and the outer CAR add around a `carBytes` inner
 * CAR: FEE's 16-byte tag per 256 KiB chunk and the outer CAR's link and
 * section per 1 MiB leaf come to about 155 bytes per MiB, plus a few hundred
 * for the headers, plus the group's bytes, which the header carries as they
 * are. A budget for size caps and funds checks, not an exact size.
 *
 * @param carBytes - The inner CAR's length.
 * @param group - The group the upload is written under: the `group` option of the write, or else, for a session, the group of the Grant it writes with (`openGrant`'s `group`). Undefined for none.
 * @throws {EncryptionError} `bad-group` for a group Keysmith refuses.
 */
export function wrapOverhead(carBytes: number, group?: string): number {
  // The header carries the canonical path, whose NFC form can be longer than what the caller passed.
  const groupBytes =
    group == null ? 0 : new TextEncoder().encode(checkGroup(group)).length
  return 4096 + groupBytes + Math.ceil(carBytes / (1024 * 1024)) * 256
}

/** An envelope's public header, as a reader sees it before it has a key. Unauthenticated. */
export interface EnvelopeHeader {
  /** Keysmith's labels as written. */
  labels: PieceMetadata
  /** The labels, parsed: owner, group key id, group, salt. */
  view: PieceMetadataView
  /** Bytes of envelope before the ciphertext. */
  headerLength: number
  /** The declared inner CAR length. */
  plaintextLength: number | undefined
}

/**
 * The public header of an encrypted upload, or undefined when `head` doesn't
 * start with one: a FEE scheme 2 header with `content_type`
 * `application/vnd.ipld.car` and format 2 Keysmith labels. Anything else is
 * plain content and needs no key. Read up to {@link ENVELOPE_PROBE_BYTES}
 * first. The header is unauthenticated until the first chunk tag verifies.
 *
 * @param head - The first bytes of a file.
 * @throws {DecryptError} `format-1` for an upload filecoin-pin 2.3 or 2.4 wrote, which is encrypted but no longer readable.
 */
export async function readEnvelopeHeader(
  head: Uint8Array
): Promise<EnvelopeHeader | undefined> {
  let info: fee.EnvelopeInfo
  try {
    info = await fee.parse(head)
  } catch {
    return undefined
  }
  if (
    info.scheme !== 'chunked' ||
    info.contentType !== CAR_CONTENT_TYPE ||
    info.appMetadata == null
  )
    return undefined
  let view: PieceMetadataView
  try {
    view = readPieceMetadata(info.appMetadata as Record<string, unknown>)
  } catch (error) {
    const format1 = format1Message(error)
    if (format1 != null) throw new DecryptError('format-1', format1)
    return undefined
  }
  return {
    labels: info.appMetadata as unknown as PieceMetadata,
    view,
    headerLength: info.params.headerLength,
    plaintextLength: info.params.plaintextLength,
  }
}

/**
 * Whether `head` starts a FEE envelope around a CAR (`content_type`
 * `application/vnd.ipld.car`), as filecoin-pin's `get` decides that a
 * download is encrypted. It reads neither the scheme nor the labels: a
 * one-shot envelope, a format 1 upload, or one with no Keysmith labels
 * counts too, and decrypting it then fails with a {@link DecryptError} that
 * says why, such as `not-encrypted` or `format-1`. {@link readEnvelopeHeader}
 * checks the scheme and the labels.
 *
 * @param head - The first bytes of a file.
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/ipfs-get.ts
 */
export async function isEnvelope(head: Uint8Array): Promise<boolean> {
  try {
    return (await fee.parse(head)).contentType === CAR_CONTENT_TYPE
  } catch {
    return false
  }
}

/** Options for {@link encrypt}. */
export interface EncryptOptions extends WriteKeyOptions {
  /** The inner CAR's exact length: `plan.contentLength`. FEE commits to it, and fails a stream of any other length. */
  contentLength: number
}

/** An encryption in progress. */
export interface Encryption {
  /**
   * The envelope's bytes: the header, then the ciphertext. Read it to the end,
   * or cancel it: the piece key lives in it until then. On an error, discard
   * everything already read.
   */
  envelope: ReadableStream<Uint8Array>
  /** The envelope's public labels. */
  labels: PieceMetadata
  /** `foc/enc`, `foc/gkid`, and `foc/kc`, for every data set this upload is written to. */
  dataSetMetadata: Record<string, string>
}

/**
 * Encrypt an inner CAR under a fresh piece key, from the owner wallet or a
 * session key's Grant. The key is derived under a fresh salt, so encrypting
 * the same input twice gives different envelopes: stage the result on disk
 * before uploading, so a resume uploads the same bytes. The piece key is
 * zeroed once the envelope stream ends, fails, or is cancelled.
 *
 * @param plaintext - The inner CAR: {@link emitInnerCar}'s bytes.
 * @param options - The credentials, the owner's data sets, the group, and the exact length.
 * @throws {KeyAccessError} When the credentials hold no key to write with.
 * @throws {EncryptionError} `encrypt-failed`, naming only an error code, with the original as `cause`, when the wallet refuses to sign or Keysmith refuses the key it signed for, such as one that doesn't match `foc/kc`. Stream errors are an {@link InputError} from the plaintext, or the same `encrypt-failed`.
 */
export async function encrypt(
  plaintext: ByteSource,
  options: EncryptOptions
): Promise<Encryption> {
  let key: NewPieceKey
  try {
    key = await newPieceKey(options)
  } catch (error) {
    // A wallet that refused to sign, or a key Keysmith refused, has no code of its own.
    throw encryptFailed(error)
  }
  let pair: ReadableWritablePair<Uint8Array, Uint8Array>
  try {
    pair = fee.encrypt({
      cek: key.cek,
      contentLength: options.contentLength,
      contentType: CAR_CONTENT_TYPE,
      appMetadata: key.labels,
    })
  } catch (error) {
    key.cek.fill(0)
    throw encryptFailed(error)
  }
  let envelope: ReadableStream<Uint8Array>
  try {
    envelope = guarded(
      toStream(plaintext).pipeThrough(pair),
      () => key.cek.fill(0),
      encryptFailed
    )
  } catch (error) {
    // A locked plaintext stream throws here, before the guard owns the key.
    key.cek.fill(0)
    throw encryptFailed(error)
  }
  return { envelope, labels: key.labels, dataSetMetadata: key.dataSetMetadata }
}

/** An encryption error, as one safe to print: this package's own as it is, any other as `encrypt-failed` with only its code, and the original as `cause`. */
const encryptFailed = (error: unknown): EncryptionError =>
  error instanceof EncryptionError
    ? error
    : new EncryptionError(
        'encrypt-failed',
        `Encryption failed: ${errorCode(error)}`,
        { cause: error }
      )

/**
 * Encrypt a planned inner CAR: {@link encrypt} over `emitInnerCar(plan, source)`,
 * with the plan's length.
 *
 * @param plan - The result of `planInnerCar`.
 * @param source - The input's bytes, for pass 2.
 * @param options - The credentials, the owner's data sets, and the group.
 */
export function encryptPlan(
  plan: InnerCarPlan,
  source: InputSource,
  options: WriteKeyOptions
): Promise<Encryption> {
  return encrypt(emitInnerCar(plan, source), {
    ...options,
    contentLength: plan.contentLength,
  })
}

const TRUNCATED =
  'The encrypted upload is incomplete (the download was probably interrupted); fetch it again'

/**
 * Any error from decrypting or unpacking, as a {@link DecryptError} whose
 * message names nothing from inside the envelope. This package's own errors
 * keep their code and message, whether FEE wrapped them or not. Any other
 * error, such as a wallet that refused to sign or a sink's `ENOSPC`, becomes
 * `decrypt-failed` with only its code in the message and the original as
 * `cause`.
 *
 * @param error - Any thrown value.
 */
export function toDecryptError(error: unknown): DecryptError {
  if (error instanceof DecryptError) return error
  // FEE wraps whatever a key resolver throws: classify the resolver's own error.
  if (error instanceof fee.errors.KeyResolutionError) {
    const { cause } = error
    if (cause instanceof EncryptionError) return toDecryptError(cause)
    const format1 = format1Message(cause)
    if (format1 != null) return new DecryptError('format-1', format1)
    return decryptFailed(cause)
  }
  if (error instanceof fee.errors.AuthenticationError) {
    return new DecryptError(
      'wrong-key-or-modified',
      'Wrong key, or the encrypted upload was modified'
    )
  }
  if (error instanceof fee.errors.InvalidPlaintextLengthError) {
    return new DecryptError(
      'wrong-key-or-modified',
      'The encrypted upload does not match its header'
    )
  }
  if (error instanceof fee.errors.InvalidCiphertextLengthError) {
    // FEE 0.1 has one class for both ends: more bytes than the header declares, or past 64 GiB, is not a cut download.
    if (
      /^Invalid encoded object: (?:received|the declared)/.test(error.message)
    )
      return new DecryptError(
        'wrong-key-or-modified',
        'The encrypted upload is longer than its header declares'
      )
    return new DecryptError('truncated', TRUNCATED)
  }
  // A range response that ended early: the stored upload is fine, so a retry can work.
  if (error instanceof fee.errors.InvalidSourceLengthError) {
    return new DecryptError(
      'incomplete-download',
      'The download ended early; try again'
    )
  }
  // A Grant or share can wrap any 32 bytes, including ones FEE refuses as a key.
  if (error instanceof fee.errors.InvalidKeyError) {
    return new DecryptError(
      'damaged-link',
      'The Grant or share holds an unusable key'
    )
  }
  if (error instanceof EncryptionError) {
    return new DecryptError(error.code, error.message)
  }
  // Encrypted with a scheme this version doesn't read, such as FEE's one-shot AES-GCM, or not a FEE envelope at all.
  // A format 1 upload is a valid envelope whose labels fail later, in the key resolver.
  if (
    error instanceof fee.errors.UnsupportedSchemeError ||
    error instanceof fee.errors.MalformedEnvelopeError
  )
    return new DecryptError('not-encrypted', NOT_ENCRYPTED)
  // WebCrypto failed: nothing is wrong with the envelope.
  if (error instanceof fee.errors.CryptoOperationError)
    return decryptFailed(error)
  if (error instanceof fee.errors.EnvelopeError) {
    // FEE's own messages describe the envelope, never the plaintext.
    return new DecryptError('malformed-envelope', error.message)
  }
  return decryptFailed(error)
}

/** Any other error, such as a sink's ENOSPC: only its code in the message, the original as the cause. */
const decryptFailed = (error: unknown): DecryptError =>
  new DecryptError('decrypt-failed', `Decryption failed: ${errorCode(error)}`, {
    cause: error,
  })

/**
 * Decrypt an envelope. The resolver gets the envelope's unauthenticated
 * header and must check its labels before it derives a key; this package's
 * resolvers do. Each 256 KiB chunk is released only after its tag verifies,
 * and the end is confirmed only at the final chunk, so discard everything
 * read when the stream fails. The resolved key is zeroed once the stream
 * ends, fails, or is cancelled, and a key that arrives after that is zeroed
 * as it arrives. Stream errors are {@link DecryptError}s.
 *
 * @param envelope - The envelope's bytes: `encrypted.fee`, from the outer CAR.
 * @param resolveKey - Returns the piece key for the envelope's labels.
 */
export function decrypt(
  envelope: ByteSource,
  resolveKey: fee.KeyResolver
): ReadableStream<Uint8Array> {
  let resolved: Uint8Array | undefined
  let ended = false
  const pair = fee.decrypt(async (info) => {
    // FEE refuses any scheme but chunked before it calls a resolver.
    if (info.contentType !== CAR_CONTENT_TYPE)
      throw new DecryptError('not-encrypted', NOT_ENCRYPTED)
    const key = await resolveKey(info)
    // The stream ended while the resolver ran: nothing will zero this key later.
    if (ended) {
      key.fill(0)
      throw new DecryptError('decrypt-failed', 'The decryption was cancelled')
    }
    resolved = key
    return key
  })
  let ciphertext: ReadableStream<Uint8Array>
  try {
    ciphertext = toStream(envelope).pipeThrough(pair)
  } catch (error) {
    // A locked envelope stream throws here, before any key exists.
    throw toDecryptError(error)
  }
  return guarded(
    ciphertext,
    () => {
      ended = true
      resolved?.fill(0)
    },
    toDecryptError
  )
}

/**
 * Decrypt an envelope and unpack its inner CAR into `sink` in one pass. It
 * resolves only once FEE has verified the final chunk and the inner CAR has
 * delivered every block its nodes name: publish the sink's output then, and
 * remove it on any error.
 *
 * @param envelope - The envelope's bytes.
 * @param resolveKey - Returns the piece key for the envelope's labels.
 * @param sink - Creates the tree and writes the bytes.
 * @param options - The name rules and limits. Set `windows` when the sink writes to a Windows file system.
 * @throws {DecryptError} With a message that names nothing from inside the envelope. A sink or source error becomes `decrypt-failed` with its code (`ENOSPC`, say) in the message and the original error as `cause`, which may name the caller's own paths. On any failure the envelope source is cancelled and the piece key zeroed.
 * @throws {RangeError} When a limit option is not a whole number of at least 0, before the envelope is read or a key is asked for.
 */
export async function decryptToSink(
  envelope: ByteSource,
  resolveKey: fee.KeyResolver,
  sink: UnpackSink,
  options: UnpackOptions = {}
): Promise<UnpackResult> {
  // A bad limit is the caller's mistake: a RangeError before any key is asked for, as openArchive throws.
  checkUnpackOptions(options)
  let plaintext: ReadableStream<Uint8Array> | undefined
  try {
    plaintext = decrypt(envelope, resolveKey)
    return await unpackInnerCar(plaintext, sink, options)
  } catch (error) {
    await plaintext?.cancel(error).catch(() => undefined)
    throw toDecryptError(error)
  }
}

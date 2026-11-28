/**
 * Checks that both inner CAR readers share: a block against its CID, a CAR
 * section's varint, and the wrapper's one entry. Errors name no entry and no
 * CID.
 *
 * @module
 */

import { decode as cborDecode } from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { type CarLayout, carHeader } from '../car/layout.ts'
import { InnerCarError } from '../errors.ts'
import { equalBytes, sha256 } from './bytes.ts'

/**
 * The most bytes a CAR header may take, its varint included. The profile's
 * header, one CIDv1 root with a sha2-256 digest, takes 59, so a reader never
 * decodes a large one.
 */
export const MAX_CAR_HEADER_BYTES = 128

/**
 * The inner CAR's root, from its whole header, `varintLength` bytes of
 * varint and then the CBOR. Both readers use it, so they refuse the same
 * headers with the same codes.
 *
 * @param bytes - The header, varint included, no longer than {@link MAX_CAR_HEADER_BYTES}.
 * @param varintLength - The varint's length.
 * @throws {InnerCarError} `bad-version` for anything but a CARv1, `bad-roots` for anything but one root, and `not-metadata-first` for bytes that aren't a CBOR map, or aren't the header the profile writes byte for byte.
 */
export function parseCarHeader(bytes: Uint8Array, varintLength: number): CID {
  const notTheProfiles = (): InnerCarError =>
    new InnerCarError(
      'not-metadata-first',
      'The inner CAR header is not the one the profile writes'
    )
  let header: unknown
  try {
    header = cborDecode(bytes.subarray(varintLength))
  } catch {
    throw notTheProfiles()
  }
  // CBOR `null`, a number, a list, or a byte string decodes fine: a header must be a map, which decodes to a plain object.
  if (header == null || Object.getPrototypeOf(header) !== Object.prototype)
    throw notTheProfiles()
  const { roots, version } = header as { roots?: unknown; version?: unknown }
  // A CARv2 starts with a version 2 pragma; its data section ends before the stream does, so FEE would never check its final chunk.
  if (version !== 1)
    throw new InnerCarError('bad-version', 'The inner CAR is not a CARv1')
  const count = Array.isArray(roots) ? roots.length : 0
  const root = Array.isArray(roots) && count === 1 ? CID.asCID(roots[0]) : null
  if (root == null) {
    throw new InnerCarError(
      'bad-roots',
      `The inner CAR must have exactly one root, not ${count}`
    )
  }
  // The header the profile writes, byte for byte, as `@ipld/car` writes it: no other key, canonical CBOR, so the offsets that follow are right.
  if (!equalBytes(bytes, carHeader(root))) throw notTheProfiles()
  return root
}

/**
 * Refuse a CAR header longer than the profile's before reading it: over the
 * metadata budget as `layout-limit`, else over {@link MAX_CAR_HEADER_BYTES}
 * as `not-metadata-first`.
 *
 * @param length - The header's length, varint included.
 * @param maxBytes - The metadata budget.
 */
export function checkHeaderLength(length: number, maxBytes: number): void {
  if (length > maxBytes)
    throw new InnerCarError(
      'layout-limit',
      `The inner CAR's metadata is over ${maxBytes} bytes`
    )
  if (length > MAX_CAR_HEADER_BYTES)
    throw new InnerCarError(
      'not-metadata-first',
      'The inner CAR header is not the one the profile writes'
    )
}

/** Multihash code of SHA2-256, the only hash the inner CAR uses. */
const SHA256_CODE = 0x12

/**
 * Check a block against its CID: sha2-256 only, as the profile writes.
 *
 * @param cid - The block's CID.
 * @param bytes - The block's bytes.
 * @throws {InnerCarError} `bad-hash` or `block-mismatch`.
 */
export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  if (cid.multihash.code !== SHA256_CODE) {
    throw new InnerCarError(
      'bad-hash',
      'The inner CAR holds a block with another hash than sha2-256'
    )
  }
  if (!equalBytes(await sha256(bytes), cid.multihash.digest)) {
    throw new InnerCarError(
      'block-mismatch',
      'An inner CAR block does not match its CID'
    )
  }
}

/**
 * The unsigned varint at `pos`: its value and its length in bytes, or
 * undefined when `bytes` ends inside it. A CAR section never needs more than
 * 8 bytes of varint. Like the spec, it refuses an encoding longer than the
 * value needs, so a reader that compares bytes and one that reads values
 * accept the same CARs.
 *
 * @param bytes - The bytes to read.
 * @param pos - Where the varint starts.
 * @throws {InnerCarError} `truncated` for a varint longer than 8 bytes, one not in its shortest form, or a value past `Number.MAX_SAFE_INTEGER`.
 * @see https://github.com/multiformats/unsigned-varint
 */
export function readVarint(
  bytes: Uint8Array,
  pos: number
): [value: number, length: number] | undefined {
  let value = 0
  for (let i = 0; i < 8; i++) {
    const byte = bytes[pos + i]
    if (byte == null) return undefined
    value += (byte & 0x7f) * 2 ** (7 * i)
    if (byte < 0x80) {
      if ((byte === 0 && i > 0) || !Number.isSafeInteger(value))
        throw new InnerCarError('truncated', 'The inner CAR is malformed')
      return [value, i + 1]
    }
  }
  throw new InnerCarError('truncated', 'The inner CAR is malformed')
}

/**
 * The wrapper's one entry: its name, and whether it is a file or a directory.
 *
 * @param lay - The inner CAR's layout.
 * @throws {InnerCarError} `not-one-entry` when the wrapper holds no entry or several.
 */
export function wrappedEntry(lay: CarLayout): {
  name: string
  kind: 'file' | 'directory'
} {
  const tops = new Set(
    [...lay.dirs, ...lay.files.keys()].map((path) => path.split('/')[0])
  )
  const [name] = tops
  if (tops.size !== 1 || name == null) {
    throw new InnerCarError(
      'not-one-entry',
      `The wrapper must hold exactly one entry, not ${tops.size}`
    )
  }
  return { name, kind: lay.files.has(name) ? 'file' : 'directory' }
}

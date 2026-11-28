/**
 * Byte layout of the metadata-first UnixFS CAR that an encrypted upload wraps
 * in its envelope: the inner CAR.
 *
 * A CARv1 has no index, so a reader that holds only the root can't locate a
 * file's bytes until it has seen every dag-pb node. The layout therefore
 * orders blocks as:
 *
 *   header, every dag-pb node (breadth-first from the root, each CID once),
 *   then every raw leaf in file order (each CID once, at its first use)
 *
 * The root is an anonymous directory with one entry, the input under its own
 * name. Given the root and the dag-pb nodes, {@link layout} computes where
 * every block sits. A decryptor then streams in one pass with memory bounded
 * by the metadata, and a viewer maps a file and an offset to a byte range
 * with no further reads.
 *
 * Ported from filecoin-pin's `src/common/unixfs-car-layout.ts` on
 * `feat/encryption-v2`, with the share link viewer's limits on work, entries,
 * and name and path lengths, and its per-file leaf index. Its errors name no
 * entry and no CID.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/unixfs-car-layout.ts
 * @see https://github.com/FilOzone/filecoin-encryption-viewer/blob/main/src/unixfs-car-layout.ts
 * @see https://ipld.io/specs/transport/car/carv1/
 * @module
 */

import { encode as cborEncode } from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { varint } from 'multiformats'
import type { CID } from 'multiformats/cid'
import { InnerCarError } from '../errors.ts'

/** Multicodec of a raw leaf. */
export const RAW_CODEC = 0x55

/** Multicodec of a UnixFS node: a directory, a HAMT shard, or a file node. */
export const DAG_PB_CODEC = 0x70

/** Multihash code of SHA2-256, the only hash the inner CAR uses. */
export const SHA256_CODE = 0x12

/** A dag-pb node of the inner CAR, with its bytes. */
export interface MetadataNode {
  /** The node's CID. */
  cid: CID
  /** The node's encoded bytes. */
  bytes: Uint8Array
}

/** One place a leaf's bytes belong in the unpacked tree. */
export interface LeafTarget {
  /** The file's wrapper-relative path, such as `report/notes/a.md`. */
  path: string
  /** Where in that file the leaf's bytes start. */
  fileOffset: number
}

/** Where one raw leaf sits in the CAR, and where its bytes go. */
export interface LeafPlacement {
  /** The leaf's CID. */
  cid: CID
  /** The leaf's length in bytes. */
  len: number
  /** Byte offset of the section (its varint prefix) inside the CAR. */
  offset: number
  /** Byte offset of the block bytes inside the CAR. */
  dataOffset: number
  /** Every file position that holds these bytes. More than one when the input repeats a chunk. */
  targets: LeafTarget[]
}

/** One leaf of a file: where in the file it starts, its length, and where it sits in the CAR. */
export interface FileLeaf {
  /** Where in the file the leaf's bytes start. */
  fileOffset: number
  /** The leaf's length in bytes. */
  len: number
  /** The leaf's place in the CAR, shared by every file position that repeats it. */
  leaf: LeafPlacement
}

/** A file of the tree: its size and its leaves in file order. */
export interface FilePlacement {
  /** The file's size in bytes. */
  size: number
  /** The file's leaves in file order, for a range read of one file. */
  leaves: FileLeaf[]
}

/** The block order and byte offsets of a whole inner CAR. */
export interface CarLayout {
  /** The CAR header bytes, varint prefix included. */
  header: Uint8Array
  /** Every dag-pb node, in CAR order. */
  metadata: { cid: CID; offset: number; len: number }[]
  /** Every raw leaf, in CAR order. */
  leaves: LeafPlacement[]
  /** Wrapper-relative file paths, in tree order, with their sizes and leaves. */
  files: Map<string, FilePlacement>
  /** Wrapper-relative directory paths, parents first. */
  dirs: string[]
  /** Total CAR length in bytes. */
  total: number
}

/** Options for the name rules. */
export interface NameOptions {
  /**
   * Also refuse the names Windows can't create or silently changes: forbidden
   * characters, a trailing dot or space, a leading space, and reserved device names. Set it
   * when writing to a Windows file system. Defaults to false.
   */
  windows?: boolean | undefined
}

/**
 * The longest entry name the layout accepts, in UTF-8 bytes. File systems
 * limit names to 255 UTF-16 units, at most 1,020 UTF-8 bytes.
 */
export const MAX_NAME_BYTES = 1024

/**
 * The largest raw leaf the layout accepts: the `unixfs-v1-2025` profile's
 * 1 MiB chunks. It bounds what one read of a leaf buffers.
 */
export const MAX_LEAF_BYTES = 1024 * 1024

/** The longest wrapper-relative path the layout accepts, in UTF-8 bytes. It bounds the layout's memory. */
export const MAX_PATH_BYTES = 4096

/**
 * The deepest the layout walks: every directory, shard, and file node on the
 * way from the root counts one. A path's length doesn't bound how deep file
 * nodes and shards nest, and the walk recurses, so this keeps a crafted DAG
 * from overflowing the call stack. A balanced file tree a few levels deep
 * already holds terabytes.
 */
export const MAX_DEPTH = 1024

/**
 * The default most bytes of metadata a reader holds: the CAR header and
 * every dag-pb section, varints and CIDs included.
 */
export const DEFAULT_MAX_METADATA_BYTES = 16 * 1024 * 1024

/**
 * The default `maxOutputBytes` of `unpackInnerCar` and `planInnerCar`: 64 GiB, the most an FEE
 * envelope holds, so a tree may restore no larger than the biggest upload
 * without deduplication.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024

/**
 * The default work budget of {@link layout}: every entry, directory, file
 * node, and leaf reference counts one. A 64 GiB upload is about 65,000 leaves;
 * the budget stops a crafted DAG that links one child many times, whose paths
 * grow exponentially.
 */
export const DEFAULT_MAX_VISITS = 1_000_000

/**
 * The default most UTF-8 bytes that every path in a tree may add up to: 128
 * MiB, 128 bytes a path at the visit budget. A reader holds every path, and a
 * crafted DAG that links one directory many times stays under the visit
 * budget while its paths add up to gigabytes.
 */
export const DEFAULT_MAX_TOTAL_PATH_BYTES = 128 * 1024 * 1024

/** The name rules and the work limits of {@link layout}. */
export interface LayoutOptions extends NameOptions {
  /** The work budget. Defaults to {@link DEFAULT_MAX_VISITS}. */
  maxVisits?: number | undefined
  /** The most files and directories the tree may hold. No limit by default. */
  maxEntries?: number | undefined
  /** The most UTF-8 bytes every path may add up to. Defaults to {@link DEFAULT_MAX_TOTAL_PATH_BYTES}. */
  maxTotalPathBytes?: number | undefined
}

/**
 * A limit option, or `fallback` when it is undefined. A limit is a whole
 * number of at least 0, or `Infinity`: `NaN` would turn every comparison
 * against it false, and so turn the limit off.
 *
 * @param name - The option's name, for the error.
 * @param value - The caller's value.
 * @param fallback - The default.
 * @throws {RangeError} When `value` is not a whole number of at least 0 or `Infinity`.
 */
export function limitOption(
  name: string,
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback
  if (!(value >= 0 && (Number.isSafeInteger(value) || value === Infinity)))
    throw new RangeError(`${name} must be a whole number of at least 0`)
  return value
}

/**
 * The bytes of `n` as an unsigned LEB128 varint, as CAR section prefixes use.
 *
 * @param n - A non-negative integer.
 */
export function encodeVarint(n: number): Uint8Array {
  return varint.encodeTo(n, new Uint8Array(varint.encodingLength(n)))
}

/**
 * The length of one CAR section: the varint prefix, the CID, and the block.
 *
 * @param cid - The block's CID.
 * @param dataLen - The block's length.
 */
export function sectionLength(cid: CID, dataLen: number): number {
  const body = cid.bytes.length + dataLen
  return varint.encodingLength(body) + body
}

/**
 * A CARv1 header for one root, with its varint prefix.
 *
 * @param root - The CAR's root.
 * @see https://ipld.io/specs/transport/car/carv1/#header
 */
export function carHeader(root: CID): Uint8Array {
  const header = cborEncode({ roots: [root], version: 1 })
  const prefix = encodeVarint(header.length)
  const out = new Uint8Array(prefix.length + header.length)
  out.set(prefix)
  out.set(header, prefix.length)
  return out
}

/** Characters Windows refuses in a file name: `<>:"|?*` and the control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const WINDOWS_FORBIDDEN = /[<>:"|?*\x00-\x1f]/
/**
 * Device names Windows reserves in any directory, with or without an
 * extension: `COM` and `LPT` take a digit or a superscript 1, 2, or 3.
 *
 * @see https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#naming-conventions
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Whether a link name could escape or alias a path when the tree is written to
 * disk: empty, `.`, `..`, holding `/`, `\`, or NUL, starting with U+FEFF,
 * which `@ipld/dag-pb` drops when it decodes a name, or holding an unpaired
 * surrogate, which it writes as U+FFFD. `\` is a separator on
 * Windows, so `..\x` would escape there. With `windows`, also the names
 * Windows can't create or silently changes.
 *
 * @param name - One path segment.
 * @param options - Whether to apply the Windows rules.
 */
export function isUnsafeName(name: string, options: NameOptions = {}): boolean {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    // dag-pb's decoder drops a leading byte order mark, and its encoder writes U+FFFD for an unpaired surrogate: the name read back would be another one.
    name.startsWith('\uFEFF') ||
    !name.isWellFormed()
  ) {
    return true
  }
  return (
    options.windows === true &&
    (WINDOWS_FORBIDDEN.test(name) ||
      /[. ]$/.test(name) ||
      // Explorer and some APIs strip a leading space too (Microsoft KB 2829981).
      name.startsWith(' ') ||
      WINDOWS_RESERVED.test(name))
  )
}

const utf8 = new TextEncoder()
const byteLength = (text: string): number => utf8.encode(text).length

interface DecodedNode {
  links: dagPb.PBLink[]
  unixfs: UnixFS | undefined
  /** The `filesize` the node's protobuf carries, which `UnixFS.unmarshal` drops. */
  filesize: bigint | undefined
}

/**
 * The `filesize` field (3) of a UnixFS `Data` protobuf, or undefined when it
 * is absent. `ipfs-unixfs` computes `fileSize()` from the block sizes and
 * doesn't keep the field it read.
 *
 * @see https://github.com/ipfs/specs/blob/main/UNIXFS.md#dag-pb-node
 */
function wireFilesize(data: Uint8Array): bigint | undefined {
  let pos = 0
  const varint = (): bigint => {
    let value = 0n
    for (let shift = 0n; shift < 64n; shift += 7n) {
      const byte = data[pos++]
      if (byte == null) throw new Error('A varint runs past the end')
      value |= BigInt(byte & 0x7f) << shift
      if (byte < 0x80) return value
    }
    throw new Error('A varint is too long')
  }
  let filesize: bigint | undefined
  while (pos < data.length) {
    const tag = varint()
    const field = tag >> 3n
    const wire = tag & 7n
    if (wire === 0n) {
      const value = varint()
      if (field === 3n) filesize = value
    } else if (wire === 2n) {
      // Read the length first: `pos += varint()` would add it to the position before the varint.
      const length = Number(varint())
      pos += length
    } else
      throw new Error('A UnixFS field has a wire type the format never uses')
  }
  if (pos !== data.length) throw new Error('A field runs past the end')
  return filesize
}

/** Multihash digest length of SHA2-256. */
const SHA256_BYTES = 32

/**
 * Compute the block order and byte offsets from the root and the dag-pb nodes
 * alone. The root must be a directory, the anonymous wrapper.
 *
 * @param root - The inner CAR's root.
 * @param nodes - Every dag-pb node, by CID string.
 * @param options - The name rules and the work limits.
 * @throws {InnerCarError} `truncated` when a linked dag-pb node is missing (the CAR isn't metadata-first, or is cut), `not-unixfs` for a node that isn't the profile's UnixFS, `unsafe-name` for a name unsafe to write, `bad-tree` for a duplicate path or a size that doesn't add up, `not-unixfs` also for a leaf over {@link MAX_LEAF_BYTES}, `layout-limit` for a tree past a limit: the work budget, `maxEntries`, `maxTotalPathBytes`, {@link MAX_DEPTH}, {@link MAX_NAME_BYTES}, or {@link MAX_PATH_BYTES}.
 * @throws {RangeError} When a limit option is not a whole number of at least 0.
 */
export function layout(
  root: CID,
  nodes: ReadonlyMap<string, MetadataNode>,
  options: LayoutOptions = {}
): CarLayout {
  const limit = (message: string): InnerCarError =>
    new InnerCarError('layout-limit', message)
  const maxVisits = limitOption(
    'maxVisits',
    options.maxVisits,
    DEFAULT_MAX_VISITS
  )
  const maxEntries = limitOption(
    'maxEntries',
    options.maxEntries,
    Number.POSITIVE_INFINITY
  )
  const maxTotalPathBytes = limitOption(
    'maxTotalPathBytes',
    options.maxTotalPathBytes,
    DEFAULT_MAX_TOTAL_PATH_BYTES
  )
  let visits = 0
  const visit = (): void => {
    if (++visits > maxVisits)
      throw limit('The inner CAR takes more work to lay out than allowed')
  }
  const descend = (depth: number): number => {
    if (depth >= MAX_DEPTH)
      throw limit(`The inner CAR nests more than ${MAX_DEPTH} nodes deep`)
    return depth + 1
  }
  const decoded = new Map<string, DecodedNode>()
  // The profile writes CIDv1 with a 32-byte sha2-256 digest, so every section's CID is 36 bytes.
  const checkCid = (cid: CID): void => {
    if (cid.version !== 1)
      throw new InnerCarError(
        'not-unixfs',
        'The inner CAR links a CIDv0, which the profile never writes'
      )
    if (
      cid.multihash.code !== SHA256_CODE ||
      cid.multihash.digest.length !== SHA256_BYTES
    )
      throw new InnerCarError(
        'bad-hash',
        'The inner CAR links a block with another hash than sha2-256'
      )
  }
  const raw = (cid: CID): MetadataNode => {
    checkCid(cid)
    const found = nodes.get(cid.toString())
    if (found == null)
      throw new InnerCarError(
        'truncated',
        'The inner CAR is missing a dag-pb node'
      )
    return found
  }
  const node = (cid: CID): DecodedNode => {
    const key = cid.toString()
    const cached = decoded.get(key)
    if (cached != null) return cached
    let value: DecodedNode
    try {
      const pb = dagPb.decode(raw(cid).bytes)
      value = {
        links: pb.Links,
        unixfs: pb.Data == null ? undefined : UnixFS.unmarshal(pb.Data),
        filesize: pb.Data == null ? undefined : wireFilesize(pb.Data),
      }
    } catch (error) {
      if (error instanceof InnerCarError) throw error
      throw new InnerCarError(
        'not-unixfs',
        'The inner CAR holds a dag-pb node that is not UnixFS'
      )
    }
    decoded.set(key, value)
    return value
  }

  // The root is the anonymous wrapper directory.
  if (root.code !== DAG_PB_CODEC)
    throw new InnerCarError('not-unixfs', 'The inner root is not a directory')
  const header = carHeader(root)
  let pos = header.length
  const metadata: CarLayout['metadata'] = []
  const seen = new Set<string>()
  const queue = [root]
  for (let i = 0; i < queue.length; i++) {
    const cid = queue[i] as CID
    const key = cid.toString()
    if (seen.has(key)) continue
    seen.add(key)
    const len = sectionLength(cid, raw(cid).bytes.length)
    metadata.push({ cid, offset: pos, len })
    pos += len
    for (const link of node(cid).links) {
      if (link.Hash.code === DAG_PB_CODEC) queue.push(link.Hash)
    }
  }

  const leaves: LeafPlacement[] = []
  const leafByCid = new Map<string, LeafPlacement>()
  const files = new Map<string, FilePlacement>()
  const dirs: string[] = []
  const dirSet = new Set<string>()
  const badTree = (message: string): InnerCarError =>
    new InnerCarError('bad-tree', message)

  const leaf = (
    cid: CID,
    size: number,
    path: string,
    fileOffset: number
  ): void => {
    visit()
    if (cid.code !== RAW_CODEC)
      throw new InnerCarError(
        'not-unixfs',
        'A file links a block that is not a raw leaf'
      )
    checkCid(cid)
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_LEAF_BYTES)) {
      throw new InnerCarError(
        'not-unixfs',
        `A leaf is larger than the profile's ${MAX_LEAF_BYTES}-byte chunks`
      )
    }
    const key = cid.toString()
    let placement = leafByCid.get(key)
    if (placement == null) {
      placement = { cid, len: size, offset: 0, dataOffset: 0, targets: [] }
      leafByCid.set(key, placement)
      leaves.push(placement)
    } else if (placement.len !== size) {
      throw badTree('A leaf is linked with two sizes')
    }
    placement.targets.push({ path, fileOffset })
    files.get(path)?.leaves.push({ fileOffset, len: size, leaf: placement })
  }

  // Returns the subtree's byte length, so the caller can advance the file offset.
  const fileTree = (
    cid: CID,
    size: number,
    path: string,
    fileOffset: number,
    depth: number
  ): number => {
    if (cid.code === RAW_CODEC) {
      leaf(cid, size, path, fileOffset)
      return size
    }
    visit()
    const below = descend(depth)
    if (cid.code !== DAG_PB_CODEC)
      throw new InnerCarError(
        'not-unixfs',
        'A file links a block of another codec'
      )
    const { links, unixfs, filesize } = node(cid)
    if (unixfs == null || (unixfs.type !== 'file' && unixfs.type !== 'raw')) {
      throw new InnerCarError(
        'not-unixfs',
        'A file links a node that is not a file node'
      )
    }
    if (unixfs.data != null && unixfs.data.length > 0) {
      throw new InnerCarError(
        'not-unixfs',
        'Inline file data is not part of the profile'
      )
    }
    if (unixfs.blockSizes.length !== links.length)
      throw badTree('A file node must have as many sizes as links')
    let offset = fileOffset
    links.forEach((link, i) => {
      const size = Number(unixfs.blockSizes[i])
      // Each child must hold what its parent says, not only the siblings together.
      if (fileTree(link.Hash, size, path, offset, below) !== size)
        throw badTree("A file node's child has another size than it records")
      offset += size
    })
    if (filesize != null && filesize !== BigInt(offset - fileOffset))
      throw badTree("A file node's filesize doesn't match its blocks")
    return offset - fileOffset
  }

  let entries = 0
  let pathBytes = 0
  const entry = (
    cid: CID,
    tsize: number,
    path: string,
    depth: number
  ): void => {
    visit()
    if (++entries > maxEntries)
      throw limit(`The inner CAR holds more than ${maxEntries} entries`)
    const bytes = byteLength(path)
    if (bytes > MAX_PATH_BYTES)
      throw limit(`The inner CAR holds a path over ${MAX_PATH_BYTES} bytes`)
    // Counted before the path is kept, so the paths a reader holds stay within the budget.
    pathBytes += bytes
    if (pathBytes > maxTotalPathBytes)
      throw limit(
        `The inner CAR's paths add up to more than ${maxTotalPathBytes} bytes`
      )
    if (files.has(path) || dirSet.has(path))
      throw badTree('The tree holds a path twice')
    if (cid.code === RAW_CODEC) {
      files.set(path, { size: tsize, leaves: [] })
      leaf(cid, tsize, path, 0)
      return
    }
    if (cid.code !== DAG_PB_CODEC)
      throw new InnerCarError(
        'not-unixfs',
        'A directory links a block of another codec'
      )
    const { unixfs } = node(cid)
    if (unixfs?.type === 'file' || unixfs?.type === 'raw') {
      const size = Number(unixfs.fileSize())
      files.set(path, { size, leaves: [] })
      if (fileTree(cid, size, path, 0, depth) !== size)
        throw badTree("A file's leaves don't add up to its size")
      return
    }
    if (unixfs?.type === 'symlink')
      throw new InnerCarError(
        'not-unixfs',
        'Symlinks are not part of the profile'
      )
    dir(cid, path, depth)
  }

  const named = (
    name: string,
    child: CID,
    tsize: number,
    path: string,
    depth: number
  ): void => {
    if (isUnsafeName(name, options))
      throw new InnerCarError(
        'unsafe-name',
        'The inner CAR holds an unsafe entry name'
      )
    if (byteLength(name) > MAX_NAME_BYTES)
      throw limit(`The inner CAR holds a name over ${MAX_NAME_BYTES} bytes`)
    entry(child, tsize, path === '' ? name : `${path}/${name}`, depth)
  }

  // HAMT shards nest: a link named with only its 2-character bucket prefix is a sub-shard of the same directory.
  const shard = (cid: CID, path: string, depth: number): void => {
    visit()
    const below = descend(depth)
    if (cid.code !== DAG_PB_CODEC)
      throw new InnerCarError('not-unixfs', 'A shard link is not a shard')
    const { links, unixfs } = node(cid)
    if (unixfs?.type !== 'hamt-sharded-directory')
      throw new InnerCarError('not-unixfs', 'A shard link is not a shard')
    for (const link of links) {
      const name = (link.Name ?? '').slice(2)
      if (name === '') shard(link.Hash, path, below)
      else named(name, link.Hash, Number(link.Tsize ?? 0), path, below)
    }
  }

  const dir = (cid: CID, path: string, depth: number): void => {
    visit()
    const below = descend(depth)
    const { links, unixfs } = node(cid)
    if (
      unixfs?.type !== 'directory' &&
      unixfs?.type !== 'hamt-sharded-directory'
    ) {
      throw new InnerCarError(
        'not-unixfs',
        'The inner CAR holds a node that is not a file or directory'
      )
    }
    if (path !== '') {
      dirs.push(path)
      dirSet.add(path)
    }
    // The shard is this directory's own node: it starts at the directory's depth.
    if (unixfs.type === 'hamt-sharded-directory') {
      shard(cid, path, depth)
      return
    }
    for (const link of links)
      named(link.Name ?? '', link.Hash, Number(link.Tsize ?? 0), path, below)
  }

  dir(root, '', 0)

  for (const placement of leaves) {
    placement.offset = pos
    placement.dataOffset =
      pos +
      encodeVarint(placement.cid.bytes.length + placement.len).length +
      placement.cid.bytes.length
    pos += sectionLength(placement.cid, placement.len)
  }

  return { header, metadata, leaves, files, dirs, total: pos }
}

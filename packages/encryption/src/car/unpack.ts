/**
 * Read an inner CAR in one streaming pass and hand its one entry to a sink.
 *
 * The dag-pb nodes arrive first, so the whole tree (names, sizes, which leaf
 * goes where) is known before the first data byte. The unpacker checks every
 * block against its CID, refuses unsafe names before the sink sees any, and
 * then hands each leaf to every file position that uses it as it streams
 * past. Memory is bounded by the metadata plus one leaf.
 *
 * The caller owns the file system: the {@link UnpackSink} creates the tree,
 * under a partial path, and writes bytes at offsets. It publishes the output
 * only after this resolves, and removes it on any failure.
 *
 * Ported from filecoin-pin's `src/common/unixfs-car-unpack.ts` on
 * `feat/encryption-v2`, which checks leaves; this one checks dag-pb nodes too.
 * Errors name no entry and no CID.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/unixfs-car-unpack.ts
 * @module
 */

import { CID } from 'multiformats/cid'
import { InnerCarError } from '../errors.ts'
import { type ByteSource, iterate } from '../internal/bytes.ts'
import {
  checkHeaderLength,
  parseCarHeader,
  readVarint,
  verifyBlock,
  wrappedEntry,
} from '../internal/car-blocks.ts'
import {
  type CarLayout,
  DAG_PB_CODEC,
  DEFAULT_MAX_METADATA_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  type LayoutOptions,
  type LeafPlacement,
  layout,
  limitOption,
  MAX_LEAF_BYTES,
  type MetadataNode,
  RAW_CODEC,
} from './layout.ts'

/** The tree inside an inner CAR, known before any data byte. */
export interface UnpackTree {
  /** The input's own name, the wrapper's one entry. */
  name: string
  /** Whether the entry is a file or a directory. */
  kind: 'file' | 'directory'
  /** Directory paths, parents first, each starting with `name`. Empty for a file. */
  dirs: string[]
  /** File paths and sizes, in tree order, each starting with `name`. */
  files: { path: string; size: number }[]
  /** The sum of every file's size: the bytes the sink must find room for. */
  bytes: number
}

/** Where an unpacked entry goes. The caller implements it over its file system. */
export interface UnpackSink {
  /**
   * Called once, after every dag-pb node checks out and before any leaf
   * arrives. Create every directory and every file, empty and at its final
   * size or not, under a partial path.
   *
   * @param tree - The entry's tree.
   */
  begin(tree: UnpackTree): Promise<void> | void
  /**
   * Write one checked leaf's bytes into a file. A leaf the input repeats is
   * written to each of its places.
   *
   * @param path - The file's path, as `begin` listed it.
   * @param offset - Byte offset in the file.
   * @param bytes - The bytes. Don't keep them past the call.
   */
  write(path: string, offset: number, bytes: Uint8Array): Promise<void> | void
}

/** What an unpack wrote. */
export interface UnpackResult {
  /** The input's own name. */
  name: string
  /** Whether the entry is a file or a directory. */
  kind: 'file' | 'directory'
  /** Files written. */
  files: number
  /** Directories written, the entry itself included. */
  dirs: number
  /** Leaf bytes written, a repeated leaf counted once per place. */
  bytes: number
}

/** The name rules and limits of {@link unpackInnerCar}. */
export interface UnpackOptions extends LayoutOptions {
  /**
   * The most bytes of metadata to hold in memory: the CAR header and every
   * dag-pb section, varints and CIDs included. Defaults to
   * {@link DEFAULT_MAX_METADATA_BYTES}. A raw leaf doesn't count.
   */
  maxMetadataBytes?: number | undefined
  /**
   * The most bytes the sink may be asked to write: the sum of every file's
   * size. A repeated leaf counts at every place it goes, so a small CAR can
   * describe a huge tree. Checked before `begin`. Defaults to
   * {@link DEFAULT_MAX_OUTPUT_BYTES}. A caller that writes to disk should
   * pass the free space it has.
   */
  maxOutputBytes?: number | undefined
}

/** The tree the sink sees, from the layout. */
function treeOf(lay: CarLayout): UnpackTree {
  const { name, kind } = wrappedEntry(lay)
  const files = [...lay.files].map(([path, file]) => ({
    path,
    size: file.size,
  }))
  return {
    name,
    kind,
    dirs: lay.dirs,
    files,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
  }
}

/** Chunks under this size are copied into one growing buffer as they arrive. */
const SMALL_CHUNK = 64 * 1024

/**
 * Exact reads from a chunk iterator. It holds only the bytes the current
 * section needs, so a section's declared length can be checked before its
 * body is read. A source may reuse a chunk's buffer once it is asked for the
 * next chunk, as Node's readers do: the bytes kept across that pull are
 * copied first.
 */
class SectionReader {
  readonly #source: AsyncIterator<Uint8Array>
  #chunks: Uint8Array[] = []
  #buffered = 0
  /** The buffers this reader allocated, which no source can reuse. */
  readonly #owned = new WeakSet<ArrayBufferLike>()
  /** The owned buffer small chunks are appended to, and how much of it is written. */
  #tail: Uint8Array | undefined
  #tailUsed = 0
  /** Whether the source has ended. */
  ended = false

  constructor(source: AsyncIterator<Uint8Array>) {
    this.#source = source
  }

  /** Buffer at least `n` bytes, or every byte left once the source ends. Returns the bytes buffered. */
  async fill(n: number): Promise<number> {
    while (this.#buffered < n && !this.ended) {
      this.#keep()
      const { done, value } = await this.#source.next()
      if (done === true) this.ended = true
      else if (value.length > 0) {
        if (value.length < SMALL_CHUNK) this.#append(value)
        else this.#chunks.push(value)
        this.#buffered += value.length
      }
    }
    return this.#buffered
  }

  /**
   * The first `n` buffered bytes, without consuming them. Never a view of a
   * buffer the source may reuse: a CID decoded from these bytes keeps a view
   * of its digest.
   */
  peek(n: number): Uint8Array {
    const first = this.#chunks[0]
    if (first != null && first.length >= n)
      return this.#owned.has(first.buffer)
        ? first.subarray(0, n)
        : new Uint8Array(first.subarray(0, n))
    const out = this.#join(Math.min(n, this.#buffered))
    this.#owned.add(out.buffer)
    this.#chunks = out.length === 0 ? [] : [out, ...this.#rest(out.length)]
    return out
  }

  /**
   * Copy the newest buffered chunk if the source may still overwrite it. Only
   * the newest can be borrowed: every older one was copied before the pull
   * that followed it, and `peek` and `take` keep views of those copies. So
   * each pull costs constant work, and each byte is copied once at most.
   */
  #keep(): void {
    const last = this.#chunks.length - 1
    const chunk = this.#chunks[last]
    if (chunk == null || this.#owned.has(chunk.buffer)) return
    // Not `slice`: on a Node Buffer it is a view of the same memory.
    const copy = new Uint8Array(chunk)
    this.#owned.add(copy.buffer)
    this.#chunks[last] = copy
  }

  /**
   * Copy a small chunk into the tail buffer, so input cut into tiny pieces
   * keeps a few buffers, not one per piece. The tail only grows at its end,
   * so views of its earlier bytes that `peek` and `take` handed out never
   * change.
   */
  #append(chunk: Uint8Array): void {
    let tail = this.#tail
    const last = this.#chunks.at(-1)
    // The newest buffered bytes, when they end where the tail's written bytes do: the chunk extends them.
    const live =
      tail != null &&
      last != null &&
      last.buffer === tail.buffer &&
      last.byteOffset + last.length === tail.byteOffset + this.#tailUsed
        ? last
        : undefined
    let start = live == null ? this.#tailUsed : this.#tailUsed - live.length
    if (tail == null || this.#tailUsed + chunk.length > tail.length) {
      // A new tail, sized from the bytes it takes over: doubling keeps the copying linear.
      const kept = live?.length ?? 0
      tail = new Uint8Array(Math.max(SMALL_CHUNK, 2 * (kept + chunk.length)))
      if (live != null) tail.set(live)
      this.#owned.add(tail.buffer)
      this.#tail = tail
      this.#tailUsed = kept
      start = 0
    }
    tail.set(chunk, this.#tailUsed)
    this.#tailUsed += chunk.length
    const view = tail.subarray(start, this.#tailUsed)
    if (live == null) this.#chunks.push(view)
    else this.#chunks[this.#chunks.length - 1] = view
  }

  /** Consume exactly `n` bytes. */
  async take(n: number): Promise<Uint8Array> {
    if ((await this.fill(n)) < n) throw cutShort()
    const out = this.#join(n)
    this.#chunks = this.#rest(n)
    this.#buffered -= n
    return out
  }

  /** A copy of the first `n` buffered bytes. */
  #join(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let filled = 0
    for (const chunk of this.#chunks) {
      if (filled === n) break
      const part = chunk.subarray(0, n - filled)
      out.set(part, filled)
      filled += part.length
    }
    return out
  }

  /** The buffered chunks after the first `n` bytes. */
  #rest(n: number): Uint8Array[] {
    const rest: Uint8Array[] = []
    let skipped = 0
    for (const chunk of this.#chunks) {
      if (skipped >= n) rest.push(chunk)
      else if (skipped + chunk.length > n)
        rest.push(chunk.subarray(n - skipped))
      skipped += chunk.length
    }
    return rest
  }
}

const cutShort = (): InnerCarError =>
  new InnerCarError('truncated', 'The inner CAR is cut short or malformed')

/** The most bytes a section's varint takes. */
const VARINT_BYTES = 8

/** The most bytes a section's CID takes: a CIDv1 with a 64-byte digest fits. */
const CID_BYTES = 96

/**
 * Unpack an inner CAR into `sink`, checking every block on the way. Each
 * section's declared length is checked against the limits before its body is
 * read: the metadata budget for the header and the dag-pb sections, the
 * layout's leaf length for a raw one.
 *
 * @param source - The inner CAR: the plaintext `decrypt` releases.
 * @param sink - Creates the tree and writes the bytes.
 * @param options - The name rules and limits. Set `windows` when the sink writes to a Windows file system.
 * @throws {InnerCarError} When the CAR isn't a valid metadata-first payload or breaks a limit: `layout-limit`, `bad-version`, `bad-roots`, `not-metadata-first`, `bad-codec`, `bad-hash`, `block-mismatch`, `out-of-order`, `truncated`, `unsafe-name`, `not-unixfs`, `not-one-entry`, `bad-tree`. An error from the sink or the source passes through unchanged.
 * @throws {RangeError} When a limit option is not a whole number of at least 0.
 */
export async function unpackInnerCar(
  source: ByteSource,
  sink: UnpackSink,
  options: UnpackOptions = {}
): Promise<UnpackResult> {
  checkUnpackOptions(options)
  const input = iterate(source)
  const reader = new SectionReader(input)
  try {
    return await unpackSections(reader, sink, options)
  } catch (error) {
    // Release the source's reader, so a caller can cancel it. A failure to close never replaces the error that stopped the unpack.
    if (!reader.ended) await input.return(undefined).catch(() => undefined)
    throw error
  }
}

/**
 * Refuse a limit option that isn't a whole number of at least 0, before any
 * byte is read or any key is asked for. `layout` checks its own limits again
 * when it runs.
 *
 * @param options - The unpack options.
 * @throws {RangeError} For the first limit that isn't a whole number of at least 0.
 */
export function checkUnpackOptions(options: UnpackOptions): void {
  limitOption('maxMetadataBytes', options.maxMetadataBytes, 0)
  limitOption('maxOutputBytes', options.maxOutputBytes, 0)
  limitOption('maxVisits', options.maxVisits, 0)
  limitOption('maxEntries', options.maxEntries, 0)
  limitOption('maxTotalPathBytes', options.maxTotalPathBytes, 0)
}

/** Read the CAR header: a CARv1 with one root, exactly as the profile writes it, within the metadata budget. Returns the root and the header's length. */
async function readHeader(
  reader: SectionReader,
  maxBytes: number
): Promise<{ root: CID; length: number }> {
  await reader.fill(8)
  const prefix = readVarint(reader.peek(8), 0)
  if (prefix == null) throw cutShort()
  const length = prefix[1] + prefix[0]
  checkHeaderLength(length, maxBytes)
  const root = parseCarHeader(await reader.take(length), prefix[1])
  return { root, length }
}

const overBudget = (maxBytes: number): InnerCarError =>
  new InnerCarError(
    'layout-limit',
    `The inner CAR's metadata is over ${maxBytes} bytes`
  )

/** The body of {@link unpackInnerCar}, over the section reader. */
async function unpackSections(
  reader: SectionReader,
  sink: UnpackSink,
  options: UnpackOptions
): Promise<UnpackResult> {
  const maxMetadataBytes = limitOption(
    'maxMetadataBytes',
    options.maxMetadataBytes,
    DEFAULT_MAX_METADATA_BYTES
  )
  const maxOutputBytes = limitOption(
    'maxOutputBytes',
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES
  )
  const header = await readHeader(reader, maxMetadataBytes)
  const { root } = header
  let metadataBytes = header.length
  const nodes = new Map<string, MetadataNode>()
  const arrived: string[] = []
  let lay: CarLayout | undefined
  let tree: UnpackTree | undefined
  let expected: LeafPlacement[] = []
  let next = 0
  let bytesWritten = 0

  const startData = async (firstLeaf: boolean): Promise<void> => {
    try {
      lay = layout(root, nodes, options)
    } catch (error) {
      // At the first leaf every node must have arrived: one still missing means the order is wrong.
      if (
        firstLeaf &&
        error instanceof InnerCarError &&
        error.code === 'truncated'
      ) {
        throw new InnerCarError(
          'not-metadata-first',
          'A leaf arrived before every dag-pb node: the CAR is not metadata-first, or is cut short'
        )
      }
      throw error
    }
    if (lay.metadata.length !== nodes.size) {
      throw new InnerCarError(
        'bad-tree',
        'The inner CAR holds a dag-pb node its tree does not use'
      )
    }
    // The order the layout computes, as openArchive requires: both readers accept the same CARs.
    if (!lay.metadata.every(({ cid }, i) => cid.toString() === arrived[i])) {
      throw new InnerCarError(
        'not-metadata-first',
        'The dag-pb nodes are not in the order an encrypted put writes them'
      )
    }
    tree = treeOf(lay)
    if (tree.bytes > maxOutputBytes) {
      throw new InnerCarError(
        'layout-limit',
        `The inner CAR restores ${tree.bytes} bytes, more than the ${maxOutputBytes} allowed`
      )
    }
    expected = lay.leaves
    await sink.begin(tree)
  }

  // The loop ends only once the source has: FEE verifies the final chunk at the end of its stream.
  // Reads stay inside the section, so nothing past the last one is pulled before the sink has it.
  while ((await reader.fill(VARINT_BYTES)) > 0) {
    const prefix = readVarint(reader.peek(VARINT_BYTES), 0)
    if (prefix == null) throw cutShort()
    const [length, varintLength] = prefix
    const headLength = varintLength + Math.min(length, CID_BYTES)
    await reader.fill(headLength)
    let cid: CID
    try {
      ;[cid] = CID.decodeFirst(reader.peek(headLength).subarray(varintLength))
    } catch {
      throw cutShort()
    }
    const blockLength = length - cid.bytes.length
    if (cid.code === DAG_PB_CODEC) {
      if (lay != null) {
        throw new InnerCarError(
          'not-metadata-first',
          'A dag-pb block follows the first leaf: the CAR is not metadata-first'
        )
      }
      metadataBytes += varintLength + length
      if (metadataBytes > maxMetadataBytes) throw overBudget(maxMetadataBytes)
      const key = cid.toString()
      if (nodes.has(key)) {
        throw new InnerCarError(
          'bad-tree',
          'The inner CAR holds a dag-pb node twice'
        )
      }
      const section = await reader.take(varintLength + length)
      const bytes = section.subarray(varintLength + cid.bytes.length)
      await verifyBlock(cid, bytes)
      nodes.set(key, { cid, bytes })
      arrived.push(key)
      continue
    }
    if (cid.code !== RAW_CODEC)
      throw new InnerCarError(
        'bad-codec',
        'The inner CAR holds a block of another codec'
      )
    if (lay == null) await startData(true)
    const leaf = expected[next]
    next++
    if (leaf == null || !leaf.cid.equals(cid)) {
      throw new InnerCarError(
        'out-of-order',
        'A leaf arrived out of order: the CAR is not metadata-first'
      )
    }
    // The layout caps a leaf at MAX_LEAF_BYTES, so this bounds what one read buffers.
    if (blockLength !== leaf.len || blockLength > MAX_LEAF_BYTES)
      throw new InnerCarError(
        'bad-tree',
        'A leaf has another size than its file node says'
      )
    const section = await reader.take(varintLength + length)
    const bytes = section.subarray(varintLength + cid.bytes.length)
    await verifyBlock(cid, bytes)
    for (const target of leaf.targets) {
      await sink.write(target.path, target.fileOffset, bytes)
      bytesWritten += bytes.length
    }
  }
  // Only directories and empty files: no leaf ever arrived.
  if (lay == null) await startData(false)
  if (next !== expected.length) {
    throw new InnerCarError(
      'truncated',
      `The inner CAR is cut short: ${next} of ${expected.length} leaves arrived`
    )
  }
  const done = tree as UnpackTree
  return {
    name: done.name,
    kind: done.kind,
    files: done.files.length,
    dirs: done.dirs.length,
    bytes: bytesWritten,
  }
}

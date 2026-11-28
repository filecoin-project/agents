/**
 * Random-access reads of an encrypted upload: list its tree and read one file
 * without decrypting the rest, as the share link viewer does over HTTP range
 * requests.
 *
 * {@link openArchive} decrypts the inner CAR's dag-pb prefix in growing
 * `decryptRange` windows from offset 0, and refuses anything but the exact
 * metadata-first CAR an encrypted put writes: a canonical one-root CARv1
 * header, every node in breadth-first order at the offsets {@link layout}
 * computes, and a total length equal to the envelope's plaintext length. Then
 * `open(path)` decrypts only that file's leaves, a few long reads each.
 *
 * Unlike the rest of the package, an archive keeps the piece key: it needs it
 * for every read. It zeroes the key on `close()`, and when opening fails.
 *
 * Ported from the viewer's `src/car-archive.ts`, which also checks node and
 * leaf hashes here, as {@link unpackInnerCar} does.
 *
 * @see https://github.com/FilOzone/filecoin-encryption-viewer/blob/main/src/car-archive.ts
 * @module
 */

import * as fee from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import {
  type CarLayout,
  DAG_PB_CODEC,
  DEFAULT_MAX_METADATA_BYTES,
  encodeVarint,
  type FileLeaf,
  type FilePlacement,
  type LayoutOptions,
  layout,
  limitOption,
  MAX_LEAF_BYTES,
  type MetadataNode,
  RAW_CODEC,
} from './car/layout.ts'
import { CAR_CONTENT_TYPE, toDecryptError } from './envelope.ts'
import { DecryptError, InnerCarError } from './errors.ts'
import { equalBytes } from './internal/bytes.ts'
import {
  checkHeaderLength,
  parseCarHeader,
  readVarint,
  verifyBlock,
  wrappedEntry,
} from './internal/car-blocks.ts'

/** The first prefix window. It doubles until the first raw leaf is in it. */
const FIRST_WINDOW_BYTES = 256 * 1024

/** The default most bytes of CAR one read of a file decrypts. */
export const DEFAULT_MAX_BATCH_BYTES = 8 * 1024 * 1024

/** Bytes past the metadata budget an archive reads to see the next section's codec: its varint and CID prefix. */
const LOOKAHEAD_BYTES = 16

/** One entry of an archive's tree. */
export interface ArchiveEntry {
  /** The wrapper-relative path, such as `report/notes/a.md`. */
  readonly path: string
  /** Whether the entry is a directory. */
  readonly directory: boolean
  /** The file's size in bytes, or 0 for a directory. */
  readonly size: number
}

/** An open encrypted upload. */
export interface Archive {
  /** The wrapper's one entry: the uploaded file or folder's name. */
  readonly name: string
  /** Whether the upload is one file or a folder. */
  readonly kind: 'file' | 'directory'
  /** Every directory and file, sorted by path. */
  list(): readonly ArchiveEntry[]
  /**
   * One file's bytes, decrypted batch by batch as the stream is read.
   *
   * @param path - A file path from {@link Archive.list}.
   * @throws {DecryptError} `not-a-file` for a path that isn't a file, `archive-closed` after `close()`.
   */
  open(path: string): ReadableStream<Uint8Array>
  /** Zero the piece key and cancel the range reads still running. Every later read fails, and a read already running releases nothing more. */
  close(): void
}

/** The limits of {@link openArchive}. */
export interface ArchiveOptions extends LayoutOptions {
  /** The most bytes of metadata prefix, the CAR header and every dag-pb section, to read. Defaults to {@link DEFAULT_MAX_METADATA_BYTES}. A raw leaf doesn't count. */
  maxMetadataBytes?: number | undefined
  /**
   * The most bytes of CAR one read of a file decrypts. A leaf is checked
   * against its CID before any of it is released, so this must hold one
   * leaf's whole section: {@link MAX_LEAF_BYTES} and 128 bytes or more.
   * Defaults to {@link DEFAULT_MAX_BATCH_BYTES}.
   *
   * A file holds one batch at a time. The inner CAR stores a repeated chunk
   * once, at its first use. A batch that holds that first use serves the
   * repeat again. A repeat whose first use is further back is decrypted
   * again, so a file whose repeats lie more than one batch apart reads more
   * bytes than the envelope holds, at most one extra section per repeat.
   */
  maxBatchBytes?: number | undefined
}

/** What every read needs: the envelope, its key, FEE's chunked-envelope parameters, and the range reads running. */
interface Reader {
  source: fee.RandomAccessSource | Uint8Array
  key: Uint8Array
  params: fee.ChunkedEnvelopeParams
  plaintextLength: number
  /** Set by `close()`. */
  closed: boolean
  /** The range reads running, for `close()` to cancel. */
  ranges: Set<ReadableStreamDefaultReader<Uint8Array>>
}

/** One file stream's range reads, and whether the stream was cancelled. */
interface FileReads {
  cancelled: boolean
  ranges: Set<ReadableStreamDefaultReader<Uint8Array>>
}

/** The most CAR bytes a leaf's section takes: its varint, a CID, and {@link MAX_LEAF_BYTES}. */
const MAX_LEAF_SECTION_BYTES = MAX_LEAF_BYTES + 128

/**
 * Open an encrypted upload for random access. It reads the envelope header,
 * resolves the piece key, and decrypts only the inner CAR's metadata, so a
 * wrong key fails after one small read.
 *
 * @param source - The envelope (`encrypted.fee`): a FEE `RandomAccessSource`, such as one over HTTP range requests, or its bytes.
 * @param resolveKey - Returns the piece key for the envelope's labels: {@link credentialKeyResolver} or {@link shareKeyResolver}, or a caller's own. The archive owns the key it returns, and zeroes it.
 * @param options - The name rules and limits.
 * @throws {RangeError} When `maxBatchBytes` isn't a whole number that holds one leaf's section, or another limit is not a whole number of at least 0.
 * @throws {DecryptError} With a message that names nothing from inside the envelope: the key error's code, `not-encrypted`, `wrong-key-or-modified`, `incomplete-download`, or an inner CAR code such as `not-metadata-first` or `layout-limit`.
 */
export async function openArchive(
  source: fee.RandomAccessSource | Uint8Array,
  resolveKey: fee.KeyResolver,
  options: ArchiveOptions = {}
): Promise<Archive> {
  const maxBatch = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  if (!(Number.isSafeInteger(maxBatch) && maxBatch >= MAX_LEAF_SECTION_BYTES)) {
    throw new RangeError(
      `maxBatchBytes must be at least ${MAX_LEAF_SECTION_BYTES}, one leaf's section`
    )
  }
  // Checked before any read: a NaN budget would never stop readPrefix.
  limitOption('maxMetadataBytes', options.maxMetadataBytes, 0)
  limitOption('maxVisits', options.maxVisits, 0)
  limitOption('maxEntries', options.maxEntries, 0)
  limitOption('maxTotalPathBytes', options.maxTotalPathBytes, 0)
  let key: Uint8Array | undefined
  try {
    const info = await fee.parse(source)
    // An inner CAR always has a header, and an empty plaintext has no chunk tag that would check the key.
    if (
      info.scheme !== 'chunked' ||
      info.contentType !== CAR_CONTENT_TYPE ||
      info.params.plaintextLength == null ||
      info.params.plaintextLength === 0
    ) {
      throw new DecryptError(
        'not-encrypted',
        'This is not an encrypted upload in the format this version reads'
      )
    }
    try {
      key = await resolveKey(info)
    } catch (error) {
      // As FEE wraps it inside decrypt, so toDecryptError reads only the resolver's errors as Keysmith's.
      throw new fee.errors.KeyResolutionError('The key resolver failed', {
        cause: error,
      })
    }
    const reader: Reader = {
      source,
      key,
      params: info.params,
      plaintextLength: info.params.plaintextLength,
      closed: false,
      ranges: new Set(),
    }
    const lay = await readLayout(reader, options)
    return createArchive(lay, reader, maxBatch)
  } catch (error) {
    key?.fill(0)
    throw toArchiveError(error)
  }
}

/**
 * An archive read's error, as {@link toDecryptError} gives it, except a
 * source of another length than the header commits to. In a stream that
 * means the download stopped early, worth retrying. Here the source's size
 * is the stored upload's, so the upload doesn't match its header, as the
 * share link viewer reads it too.
 */
const toArchiveError = (error: unknown): DecryptError =>
  error instanceof fee.errors.InvalidCiphertextLengthError
    ? new DecryptError(
        'wrong-key-or-modified',
        'The encrypted upload does not match its header'
      )
    : toDecryptError(error)

/** The inner CAR read up to its first raw leaf. */
interface Prefix {
  root?: CID
  headerLength: number
  pos: number
  nodes: Map<string, MetadataNode>
  sections: { cid: CID; offset: number; len: number }[]
}

const notMetadataFirst = (): InnerCarError =>
  new InnerCarError(
    'not-metadata-first',
    'The inner CAR is not the metadata-first CAR an encrypted put writes'
  )

/** Read the prefix, lay the tree out, and check the layout is exactly the prefix. */
async function readLayout(
  reader: Reader,
  options: ArchiveOptions
): Promise<CarLayout> {
  const prefix = await readPrefix(reader, options)
  if (prefix.root == null) throw notMetadataFirst()
  let lay: CarLayout
  try {
    lay = layout(prefix.root, prefix.nodes, options)
  } catch (error) {
    // Every node precedes the first leaf, so one missing from the prefix means the order is wrong.
    if (error instanceof InnerCarError && error.code === 'truncated')
      throw notMetadataFirst()
    throw error
  }
  const inOrder =
    lay.header.length === prefix.headerLength &&
    lay.metadata.length === prefix.sections.length &&
    lay.metadata.every((node, i) => {
      const section = prefix.sections[i]
      return (
        section != null &&
        node.cid.equals(section.cid) &&
        node.offset === section.offset &&
        node.len === section.len
      )
    })
  if (!inOrder || lay.total !== reader.plaintextLength) throw notMetadataFirst()
  return lay
}

/**
 * Decrypt windows from offset 0, each continuing where the last ended and
 * twice as long, until the first raw section header or the end of the
 * plaintext: a folder of empty folders has no leaf.
 */
async function readPrefix(
  reader: Reader,
  options: ArchiveOptions
): Promise<Prefix> {
  const total = reader.plaintextLength
  const maxBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES
  const prefix: Prefix = {
    headerLength: 0,
    pos: 0,
    nodes: new Map(),
    sections: [],
  }
  // The budget bounds what is read: enough past it to see that the next section is a leaf, and no more.
  const readable = Math.min(total, maxBytes + LOOKAHEAD_BYTES)
  // `buffer` holds the bytes from `base` on: what parseSections hasn't consumed, and the new window.
  let buffer = new Uint8Array(0)
  let base = 0
  let window = FIRST_WINDOW_BYTES
  for (;;) {
    const read = base + buffer.length
    const length = Math.min(window, readable - read)
    const next = new Uint8Array(buffer.length + length)
    next.set(buffer)
    next.set(await decryptAt(reader, read, length), buffer.length)
    buffer = next
    if (await parseSections(buffer, base, prefix, maxBytes)) return prefix
    const have = base + buffer.length
    if (have >= total) {
      if (prefix.pos !== have) throw notMetadataFirst()
      return prefix
    }
    if (have >= readable) throw overBudget(maxBytes)
    // Keep only the unparsed tail, so a doubling window copies no more than that.
    buffer = buffer.subarray(prefix.pos - base)
    base = prefix.pos
    window *= 2
  }
}

const overBudget = (maxBytes: number): InnerCarError =>
  new InnerCarError(
    'layout-limit',
    `The inner CAR's metadata is over ${maxBytes} bytes`
  )

/**
 * Advance `prefix` over the complete sections `buffer` holds, where
 * `buffer[0]` is the byte at CAR offset `base`. True once the next section is
 * a raw leaf. The nodes it keeps are copies, so `buffer` can be dropped.
 */
async function parseSections(
  buffer: Uint8Array,
  base: number,
  prefix: Prefix,
  maxBytes: number
): Promise<boolean> {
  // The header is parsed before readPrefix drops anything, so it sits at 0.
  if (prefix.root == null) {
    const header = readVarint(buffer, 0)
    if (header != null) checkHeaderLength(header[1] + header[0], maxBytes)
    if (header == null || buffer.length < header[1] + header[0]) return false
    prefix.headerLength = header[1] + header[0]
    prefix.root = parseCarHeader(
      buffer.subarray(0, prefix.headerLength),
      header[1]
    )
    prefix.pos = prefix.headerLength
  }
  for (;;) {
    const section = readVarint(buffer, prefix.pos - base)
    if (section == null) return false
    const [len, varintLength] = section
    const start = prefix.pos + varintLength
    const at = start - base
    if (buffer.length - at < 2) return false
    // CIDv1: the version byte, then the codec, both one byte for the codecs the profile uses.
    if (buffer[at] !== 1) throw notMetadataFirst()
    const codec = buffer[at + 1]
    if (codec === RAW_CODEC) return true
    if (codec !== DAG_PB_CODEC) {
      throw new InnerCarError(
        'bad-codec',
        'The inner CAR holds a block of another codec'
      )
    }
    // Only metadata counts: the header and every dag-pb section so far, this one included.
    if (start + len > maxBytes) throw overBudget(maxBytes)
    if (buffer.length < at + len) return false
    let cid: CID
    let bytes: Uint8Array
    try {
      ;[cid, bytes] = CID.decodeFirst(buffer.slice(at, at + len))
    } catch {
      throw notMetadataFirst()
    }
    await verifyBlock(cid, bytes)
    prefix.nodes.set(cid.toString(), { cid, bytes })
    prefix.sections.push({ cid, offset: prefix.pos, len: varintLength + len })
    prefix.pos = start + len
  }
}

const closedError = (): DecryptError =>
  new DecryptError('archive-closed', 'The archive is closed')

/** Why a range read stopped before it finished: the archive closed, or its file stream was cancelled. */
function stopped(reader: Reader, file: FileReads | undefined): boolean {
  return reader.closed || file?.cancelled === true
}

/**
 * Decrypt exactly `length` plaintext bytes at `offset`. The range read is
 * listed in `reader.ranges`, and in `file.ranges` when given, until it
 * settles, so `close()` or a cancelled file stream can stop it. FEE opens the
 * range on the first read, so a stop while FEE imports the key starts no
 * request.
 */
async function decryptAt(
  reader: Reader,
  offset: number,
  length: number,
  file?: FileReads
): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array(0)
  if (stopped(reader, file)) throw closedError()
  const { stream } = await fee.decryptRange(
    reader.source,
    reader.key,
    { offset, length },
    { params: reader.params }
  )
  if (stopped(reader, file)) {
    await stream.cancel().catch(() => undefined)
    throw closedError()
  }
  const chunks = stream.getReader()
  reader.ranges.add(chunks)
  file?.ranges.add(chunks)
  const out = new Uint8Array(length)
  let filled = 0
  try {
    while (filled < length && !stopped(reader, file)) {
      const { done, value } = await chunks.read()
      if (done) break
      if (filled + value.length > length) break
      out.set(value, filled)
      filled += value.length
    }
  } finally {
    reader.ranges.delete(chunks)
    file?.ranges.delete(chunks)
    // A range read that stops early is cancelled, so its download stops too.
    if (filled !== length) await chunks.cancel().catch(() => undefined)
    chunks.releaseLock()
  }
  if (stopped(reader, file)) {
    out.fill(0)
    throw closedError()
  }
  if (filled !== length)
    throw new fee.errors.InvalidSourceLengthError('The range ended early')
  return out
}

/** The archive over a checked layout. */
function createArchive(
  lay: CarLayout,
  reader: Reader,
  maxBatch: number
): Archive {
  const { name, kind } = wrappedEntry(lay)
  const entries: readonly ArchiveEntry[] = Object.freeze(
    [
      ...lay.dirs.map((path) => ({ path, directory: true, size: 0 })),
      ...[...lay.files].map(([path, file]) => ({
        path,
        directory: false,
        size: file.size,
      })),
    ]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => Object.freeze(entry))
  )
  return {
    name,
    kind,
    list: () => entries,
    open(path) {
      if (reader.closed) throw closedError()
      const file = lay.files.get(path)
      if (file == null)
        throw new DecryptError('not-a-file', 'The archive has no such file')
      return readFile(file, reader, maxBatch)
    },
    close() {
      reader.closed = true
      reader.key.fill(0)
      for (const range of reader.ranges) range.cancel().catch(() => undefined)
    },
  }
}

const end = (item: FileLeaf): number => item.leaf.dataOffset + item.len

/** A run of whole sections to decrypt in one read, and the file's leaves that it holds. */
interface Run {
  items: FileLeaf[]
  /** CAR offset of the run's first section. */
  start: number
  /** CAR offset where the run's last section ends. */
  end: number
}

/**
 * Group a file's leaves into runs of sections that are contiguous in the CAR,
 * each at most `maxBatch` bytes of CAR. A repeated chunk points back to its
 * first use: when that section is already inside the run, the run serves it
 * again without another read. An empty leaf is a section too, and is checked
 * like any other.
 */
function batches(file: FilePlacement, maxBatch: number): Run[] {
  const out: Run[] = []
  let run: Run | undefined
  for (const item of file.leaves) {
    if (run != null && item.leaf.offset >= run.start && end(item) <= run.end) {
      run.items.push(item)
      continue
    }
    if (
      run != null &&
      item.leaf.offset === run.end &&
      end(item) - run.start <= maxBatch
    ) {
      run.items.push(item)
      run.end = end(item)
      continue
    }
    if (run != null) out.push(run)
    run = { items: [item], start: item.leaf.offset, end: end(item) }
  }
  if (run != null) out.push(run)
  return out
}

/** The bytes a leaf's section starts with: its varint and its CID. */
function sectionHead(item: FileLeaf): Uint8Array {
  const { cid } = item.leaf
  const prefix = encodeVarint(cid.bytes.length + item.len)
  const head = new Uint8Array(prefix.length + cid.bytes.length)
  head.set(prefix)
  head.set(cid.bytes, prefix.length)
  return head
}

/**
 * One file as a stream. A pull hands out one checked leaf: it decrypts the
 * next batch of whole sections when the last one is spent, and checks each
 * section's varint and CID, and each leaf against its CID. With
 * `highWaterMark: 0`, every leaf goes to a read that is waiting, so nothing
 * sits in the stream's queue after `close()`, and the archive holds no
 * reference to the stream. Cancelling the stream cancels its range read.
 */
function readFile(
  file: FilePlacement,
  reader: Reader,
  maxBatch: number
): ReadableStream<Uint8Array> {
  const runs = batches(file, maxBatch)
  const reads: FileReads = { cancelled: false, ranges: new Set() }
  let next = 0
  /** The decrypted batch being handed out, the next leaf of it, and the leaves it has already checked. */
  let batch:
    | {
        data: Uint8Array
        run: Run
        index: number
        verified: Set<FileLeaf['leaf']>
      }
    | undefined
  const drop = (): void => {
    batch?.data.fill(0)
    batch = undefined
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (reader.closed) throw closedError()
          if (batch == null) {
            const run = runs[next++]
            if (run == null) {
              controller.close()
              return
            }
            const data = await decryptAt(
              reader,
              run.start,
              run.end - run.start,
              reads
            )
            batch = { data, run, index: 0, verified: new Set() }
          }
          const { data, run, verified } = batch
          const { start } = run
          const item = run.items[batch.index++] as FileLeaf
          const last = batch.index === run.items.length
          const head = data.subarray(
            item.leaf.offset - start,
            item.leaf.dataOffset - start
          )
          if (!equalBytes(head, sectionHead(item))) throw notMetadataFirst()
          // A copy, so the batch can be zeroed once spent or abandoned.
          const bytes = data.slice(
            item.leaf.dataOffset - start,
            end(item) - start
          )
          // A repeat of a leaf this batch already checked is the same bytes.
          if (!verified.has(item.leaf)) {
            await verifyBlock(item.leaf.cid, bytes)
            verified.add(item.leaf)
          }
          if (stopped(reader, reads)) throw closedError()
          controller.enqueue(bytes)
          if (last) drop()
          // Close with the last leaf, so a reader that stops at the file's size sees the end without another read.
          if (last && next >= runs.length) controller.close()
        } catch (error) {
          drop()
          throw toArchiveError(error)
        }
      },
      async cancel() {
        reads.cancelled = true
        drop()
        await Promise.all([...reads.ranges].map((range) => range.cancel()))
      },
    },
    { highWaterMark: 0 }
  )
}

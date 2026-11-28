/**
 * Build the inner CAR of an encrypted upload from a file or folder, in two
 * passes, so no plaintext is written anywhere:
 *
 *   pass 1  the UnixFS importer, with the `unixfs-v1-2025` profile and an
 *           anonymous wrapping directory, computes the DAG. dag-pb nodes are
 *           kept in memory; leaf bytes are not.
 *   pass 2  every leaf is read again at its offset and emitted in layout order.
 *
 * The caller owns the file system and the walk. It lists the entries itself,
 * so its own rules (dotfiles, symlinks, special files) decide what goes in.
 * It names the wrapper's entry explicitly, and it reads bytes through a small
 * {@link InputSource}. A file that changes between the passes yields leaves
 * that no longer match their CIDs, so pass 2 reads and hashes every place a
 * leaf is used, and checks that no file grew, before the stream ends.
 *
 * Ported from filecoin-pin's `src/common/unixfs-car-payload.ts` on
 * `feat/encryption-v2`. Errors name an entry by its position, never its path.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/unixfs-car-payload.ts
 * @see https://github.com/ipfs/specs/pull/499
 * @module
 */

import * as dagPb from '@ipld/dag-pb'
import * as fee from 'filecoin-encryption-envelope'
import {
  type BufferImporter,
  type ImportCandidate,
  type ImporterOptions,
  importer,
  type WritableStorage,
} from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import { create as createDigest } from 'multiformats/hashes/digest'
import { errorCode, InnerCarError, InputError } from '../errors.ts'
import { equalBytes, hashable, sha256 } from '../internal/bytes.ts'
import {
  type CarLayout,
  DAG_PB_CODEC,
  DEFAULT_MAX_METADATA_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  encodeVarint,
  isUnsafeName,
  layout,
  limitOption,
  type MetadataNode,
  type NameOptions,
  RAW_CODEC,
  SHA256_CODE,
} from './layout.ts'

/**
 * One entry inside a folder input, as the caller's walk lists it. The path is
 * relative to the folder, with `/` separators: `a.jpg`, `raw`, `raw/b.jpg`.
 */
export type InputEntry =
  | {
      /** A directory. */
      type: 'directory'
      /** Its path inside the folder. */
      path: string
    }
  | {
      /** A regular file. */
      type: 'file'
      /** Its path inside the folder. */
      path: string
      /** Its size in bytes, from the walk. */
      size: number
    }

/**
 * The input to pack: one file, or a folder and its walked entries. `name` is
 * the wrapper's one entry, the name a reader restores. The CLI passes
 * `basename(resolve(input))`, never a display name.
 */
export type InnerCarInput =
  | {
      /** A single file. */
      type: 'file'
      /** The file's name. */
      name: string
      /** Its size in bytes. */
      size: number
    }
  | {
      /** A folder. */
      type: 'directory'
      /** The folder's name. */
      name: string
      /** Everything inside it that goes into the upload, from the caller's walk. */
      entries: readonly InputEntry[]
    }

/** Options for {@link InputSource.stream}. */
export interface StreamOptions {
  /**
   * Aborted when pass 1 fails and stops reading. A source whose pending read
   * can't end on `return()`, such as an async generator's, ends it here, so
   * the failure reaches the caller without waiting for that read.
   * See {@link https://developer.mozilla.org/docs/Web/API/AbortSignal | AbortSignal}.
   */
  signal: AbortSignal
}

/** How the packer reads the input's bytes. The caller implements it over its file system. */
export interface InputSource {
  /**
   * Every byte of one file, in order, for pass 1.
   *
   * @param path - The file's path inside the folder, as listed, or `''` for a single-file input.
   * @param options - The signal that stops the read when pass 1 fails.
   */
  stream(path: string, options: StreamOptions): AsyncIterable<Uint8Array>
  /**
   * `length` bytes of one file from `offset`, for pass 2. Fewer bytes mean the
   * file shrank. A read past the file's end returns only the bytes up to it:
   * after its leaves, pass 2 reads one byte at each file's planned end, to see
   * that the file didn't grow.
   *
   * @param path - The file's path inside the folder, as listed, or `''` for a single-file input.
   * @param offset - Byte offset in the file.
   * @param length - Bytes to read.
   */
  read(path: string, offset: number, length: number): Promise<Uint8Array>
}

/** Options for {@link planInnerCar}. */
export interface PlanOptions extends NameOptions {
  /**
   * The largest upload, in bytes, this inner CAR may become once wrapped:
   * `total + overhead(total)` must fit. The files alone are checked before any
   * hashing. Defaults to no limit.
   */
  maxBytes?: number | undefined
  /** Bytes the caller adds around an inner CAR of `carBytes`, such as `wrapOverhead`. Defaults to none. */
  overhead?: ((carBytes: number) => number) | undefined
  /**
   * The most bytes of metadata, the CAR header and every dag-pb section, the
   * inner CAR may hold. Defaults to {@link DEFAULT_MAX_METADATA_BYTES}, the
   * default of this package's readers, `unpackInnerCar` and `openArchive`, so
   * that every upload written with the default opens in them with default
   * options. A larger value needs the same `maxMetadataBytes` on every read.
   * The share link viewer has limits of its own: it also refuses an archive
   * of more than 10,000 entries, which this doesn't check.
   *
   * @see https://github.com/FilOzone/filecoin-encryption-viewer/blob/c108264fdc3abfd68f9d59310434b536980865a3/src/car-archive.ts
   */
  maxMetadataBytes?: number | undefined
  /**
   * The most bytes the input's files may add up to: what a full restore
   * writes. Checked against the walk's sizes before any hashing, and against
   * the sizes pass 1 actually read. Defaults to
   * {@link DEFAULT_MAX_OUTPUT_BYTES}, the restore default, so a deduplicated
   * input that fits in one upload still restores with default options. A
   * full restore with `unpackInnerCar` or `decryptToSink` needs a
   * `maxOutputBytes` at least as large as what the upload restores, its
   * files' total size, not this cap. `openArchive` reads one file at a time
   * and has no such limit.
   */
  maxOutputBytes?: number | undefined
}

/** The result of pass 1: everything pass 2 needs, and the exact plaintext length. */
export interface InnerCarPlan {
  /** The inner root: the wrapping directory's CID. Keep it private: it is the plaintext root CID. */
  root: CID
  /** The CID of the input itself, the wrapper's one link. It matches a plain put of the same input. */
  entryCid: CID
  /** The input's own name, the wrapper's one entry. */
  name: string
  /** Whether the input is a directory. */
  isDirectory: boolean
  /** Every dag-pb node by CID string. */
  nodes: Map<string, MetadataNode>
  /** The block order and byte offsets. */
  layout: CarLayout
  /** Exact inner CAR length, known before any byte is emitted: FEE's `plaintext_length`. */
  contentLength: number
  /**
   * For each wrapper-relative file path in the layout, the path the source
   * reads it by and its 1-based position in the caller's list, the only way
   * errors refer to it.
   */
  sources: Map<string, { path: string; position: number }>
}

const entryError = (code: string, entry: number, what: string): InputError =>
  new InputError(code, `${what} (entry #${entry})`)

/** A file to import: its wrapper-relative path, its source path, size, and position. */
interface PlannedFile {
  path: string
  source: string
  size: number
  position: number
}

/**
 * Check the input: a safe wrapper name, safe segments, no path twice, and no
 * entry under a file.
 * Positions count from 1 in the caller's entry list; a single file is #1.
 */
function checkInput(
  input: InnerCarInput,
  options: NameOptions
): { dirs: string[]; files: PlannedFile[] } {
  if (isUnsafeName(input.name, options)) {
    throw new InputError(
      'unsafe-name',
      'The input has a name that cannot be restored safely'
    )
  }
  if (input.type === 'file') {
    if (!(Number.isSafeInteger(input.size) && input.size >= 0)) {
      throw entryError('bad-entries', 1, 'An entry has an invalid size')
    }
    return {
      dirs: [],
      files: [{ path: input.name, source: '', size: input.size, position: 1 }],
    }
  }
  const dirs = [input.name]
  const files: PlannedFile[] = []
  const seen = new Set<string>()
  input.entries.forEach((entry, i) => {
    const position = i + 1
    for (const segment of entry.path.split('/')) {
      // `\` is a separator on Windows, so such a name couldn't be restored safely there.
      if (isUnsafeName(segment, options)) {
        throw entryError(
          'unsafe-name',
          position,
          'An entry has a name that cannot be restored safely'
        )
      }
    }
    if (seen.has(entry.path))
      throw entryError('bad-entries', position, 'An entry is listed twice')
    seen.add(entry.path)
    const path = `${input.name}/${entry.path}`
    if (entry.type === 'directory') {
      dirs.push(path)
      return
    }
    if (!(Number.isSafeInteger(entry.size) && entry.size >= 0)) {
      throw entryError('bad-entries', position, 'An entry has an invalid size')
    }
    files.push({ path, source: entry.path, size: entry.size, position })
  })
  // The importer replaces a directory listed after one of its children, dropping the child: parents go first.
  // Keep this sort until https://github.com/ipfs/js-ipfs-unixfs/issues/509 is fixed.
  const depth = (path: string): number => path.split('/').length
  dirs.sort((a, b) => depth(a) - depth(b))
  // A file can't hold entries: the importer would keep one and silently drop the other.
  const filePaths = new Set(files.map((f) => f.source))
  input.entries.forEach((entry, i) => {
    const segments = entry.path.split('/')
    for (let end = 1; end < segments.length; end++) {
      if (filePaths.has(segments.slice(0, end).join('/')))
        throw entryError('bad-entries', i + 1, 'An entry sits under a file')
    }
  })
  return { dirs, files }
}

/** An input file whose size or bytes differ from what the walk or pass 1 saw. */
const changedError = (position: number): InputError =>
  entryError(
    'changed',
    position,
    'An input file changed during encryption; run again'
  )

/** The most bytes a FEE header takes: FEE refuses a larger envelope. */
const FEE_HEADER_BYTES = 1024 * 1024

/** The bytes of FEE's authentication tag on each chunk. */
const FEE_TAG_BYTES = 16

/**
 * Whether FEE can encode an inner CAR of `carBytes`: the whole object, its
 * header and a 16-byte tag per 256 KiB chunk included, within FEE's
 * `MAX_ENCODED_OBJECT_SIZE`. The header is budgeted at the most FEE allows.
 *
 * @internal
 * @param carBytes - The inner CAR's length.
 * @see https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0120.md
 */
export function feeFits(carBytes: number): boolean {
  const tags =
    Math.ceil(carBytes / fee.constants.DEFAULT_CHUNK_SIZE) * FEE_TAG_BYTES
  return (
    carBytes + tags + FEE_HEADER_BYTES <= fee.constants.MAX_ENCODED_OBJECT_SIZE
  )
}

/** How many leaves pass 1 hashes at once, as filecoin-pin does. */
const HASH_CONCURRENCY = 8

/**
 * How many files pass 1 reads at once. The importer's default is 50, which
 * opens 50 files and holds up to 50 × {@link HASH_CONCURRENCY} leaves.
 */
const FILE_CONCURRENCY = 4

/**
 * A raw-leaf importer that hashes each leaf with WebCrypto, so the importer's
 * `blockWriteConcurrency` leaves hash at once, in browsers too. Pass 1 hands
 * the importer copies of the source's chunks, so a source that reuses its
 * buffer can't change a leaf before it is hashed. Pass 2 checks every leaf
 * against its CID again.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/master/src/common/unixfs-car-payload.ts
 */
const parallelHashImporter: BufferImporter = (file, blockstore) =>
  (async function* () {
    for await (const chunk of file.content) {
      const digest = crypto.subtle.digest('SHA-256', hashable(chunk))
      // A rejected digest is awaited by the job below; this keeps it from counting as unhandled first.
      digest.catch(() => undefined)
      yield async () => {
        const cid = CID.createV1(
          RAW_CODEC,
          createDigest(SHA256_CODE, new Uint8Array(await digest))
        )
        await blockstore.put(cid, chunk)
        return { cid, size: BigInt(chunk.length), block: chunk }
      }
    }
  })()

/**
 * Pass 1: compute the DAG and its byte layout, reading every file once. The
 * caller walks the input with its own rules; this checks only the names.
 *
 * @param input - A single file, or a folder with its entries, and the name to restore it under.
 * @param source - Reads the files' bytes.
 * @param options - The size cap and the name rules.
 * @throws {InputError} `bad-entries`, `unsafe-name`, `unreadable`, `changed` when a file's size differs from the one listed, or `too-large`. Messages name an entry by its position only.
 * @throws {RangeError} When a limit option is not a whole number of at least 0.
 */
export async function planInnerCar(
  input: InnerCarInput,
  source: InputSource,
  options: PlanOptions = {}
): Promise<InnerCarPlan> {
  const { name } = input
  const isDirectory = input.type === 'directory'
  const { dirs, files } = checkInput(input, options)
  const maxBytes = limitOption(
    'maxBytes',
    options.maxBytes,
    Number.POSITIVE_INFINITY
  )
  const maxOutputBytes = limitOption(
    'maxOutputBytes',
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES
  )
  const maxMetadataBytes = limitOption(
    'maxMetadataBytes',
    options.maxMetadataBytes,
    DEFAULT_MAX_METADATA_BYTES
  )
  const overhead = options.overhead ?? (() => 0)
  const tooBig = (what: string, bytes: number): InputError =>
    new InputError(
      'too-large',
      `${what} is ${bytes} bytes. Encrypted, it needs up to ${bytes + overhead(bytes)} bytes, more than the ${maxBytes} bytes one upload can hold`
    )
  const inputBytes = files.reduce((sum, f) => sum + f.size, 0)
  if (inputBytes > maxOutputBytes) {
    throw new InputError(
      'too-large',
      `The input is ${inputBytes} bytes, more than the ${maxOutputBytes} bytes a reader restores by default`
    )
  }
  if (inputBytes + overhead(inputBytes) > maxBytes)
    throw tooBig('The input', inputBytes)

  const nodes = new Map<string, MetadataNode>()
  // The importer's multiformats may be another copy than ours: cross by bytes.
  const blockstore: WritableStorage = {
    put(cid, bytes) {
      if (cid.code === DAG_PB_CODEC && bytes instanceof Uint8Array) {
        const ours = CID.decode(cid.bytes)
        nodes.set(ours.toString(), { cid: ours, bytes })
      }
      return cid
    },
  }
  // The importer reads several files at once, and leaves the others running when one fails: `stop` ends them.
  const reading = new Set<AsyncIterator<Uint8Array>>()
  // For a read that return() can't end while it is pending, as an async generator's.
  const abort = new AbortController()
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    try {
      abort.abort(new InputError('unreadable', 'Packing stopped'))
    } catch {
      // A listener that throws stops nothing else, and hides no error.
    }
    for (const iterator of reading) {
      try {
        Promise.resolve(iterator.return?.()).catch(() => undefined)
      } catch {
        // A cleanup that throws stops nothing else, and hides no error.
      }
    }
    // Each read is ended once: the readers' own cleanup skips them.
    reading.clear()
  }
  async function* read(file: PlannedFile): AsyncGenerator<Uint8Array> {
    if (stopped) return
    let bytes = 0
    let iterator: AsyncIterator<Uint8Array> | undefined
    // Whether the source ended on its own, so it needs no return().
    let finished = false
    try {
      const opened = source
        .stream(file.source, { signal: abort.signal })
        [Symbol.asyncIterator]()
      iterator = opened
      reading.add(opened)
      // Not `for await`: on a throw it awaits the source's return() before the catch could abort the others.
      for (;;) {
        const step = await opened.next()
        if (step.done === true) {
          finished = true
          break
        }
        if (stopped) return
        const chunk = step.value
        bytes += chunk.length
        // A file that grew is refused at the first extra chunk, not hashed to its end.
        if (bytes > file.size) throw changedError(file.position)
        // A copy: the importer's chunker holds chunks until it has a whole leaf, and the source may reuse its buffer.
        yield new Uint8Array(chunk)
      }
      if (stopped) return
      // A file that changed size since the walk would pack bytes the caller never listed.
      if (bytes !== file.size) throw changedError(file.position)
    } catch (error) {
      // After a stop, nothing awaits this file: its own failure would go unhandled.
      if (stopped) return
      const failure =
        error instanceof InputError
          ? error
          : entryError(
              'unreadable',
              file.position,
              `Cannot read an input entry: ${errorCode(error)}`
            )
      // The importer waits for files in order, so every read, this one included, is stopped here, not when the failure reaches it.
      stop()
      throw failure
    } finally {
      if (iterator != null && reading.delete(iterator) && !finished) {
        // The importer stopped early, or this file is done with: end the read, as `for await` would.
        try {
          await iterator.return?.()
        } catch {
          // A cleanup that throws hides no error.
        }
      }
    }
  }
  function* candidates(): Generator<ImportCandidate> {
    for (const path of dirs) yield { path }
    for (const file of files) yield { path: file.path, content: read(file) }
  }
  const importerOptions: ImporterOptions = {
    profile: 'unixfs-v1-2025',
    wrapWithDirectory: true,
    bufferImporter: parallelHashImporter,
    blockWriteConcurrency: HASH_CONCURRENCY,
    fileImportConcurrency: FILE_CONCURRENCY,
  }
  let root: CID | undefined
  let entryCid: CID | undefined
  try {
    for await (const imported of importer(
      candidates(),
      blockstore,
      importerOptions
    )) {
      const cid = CID.decode(imported.cid.bytes)
      if (imported.path === name) entryCid = cid
      root = cid
    }
  } catch (error) {
    stop()
    if (error instanceof InputError) throw error
    throw new InputError(
      'unreadable',
      `The input cannot be packed: ${errorCode(error)}`
    )
  }
  // The importer yields no entry for an empty root folder: its one link in the wrapper names it.
  if (root != null && entryCid == null) {
    const wrapper = nodes.get(root.toString())
    const links = wrapper == null ? [] : dagPb.decode(wrapper.bytes).Links
    const [link] = links
    if (links.length === 1 && link?.Name === name)
      entryCid = CID.decode(link.Hash.bytes)
  }
  if (root == null || entryCid == null)
    throw new InputError('bad-entries', 'The importer produced no root')
  let lay: CarLayout
  try {
    lay = layout(root, nodes, options)
  } catch (error) {
    if (error instanceof InnerCarError)
      throw new InputError(
        'bad-entries',
        `The input cannot be packed: ${error.code}`
      )
    throw error
  }
  if (lay.total + overhead(lay.total) > maxBytes)
    throw tooBig('The packed input', lay.total)
  if (!feeFits(lay.total)) {
    throw new InputError(
      'too-large',
      `The packed input is ${lay.total} bytes, more than FEE encodes in one upload: ${fee.constants.MAX_ENCODED_OBJECT_SIZE} bytes, its header and chunk tags included`
    )
  }
  const last = lay.metadata.at(-1)
  const metadataBytes =
    last == null ? lay.header.length : last.offset + last.len
  if (metadataBytes > maxMetadataBytes) {
    throw new InputError(
      'too-large',
      `The input's tree needs ${metadataBytes} bytes of metadata, more than the ${maxMetadataBytes} bytes a reader accepts by default. Split it into smaller uploads`
    )
  }
  // The importer also writes an empty node for each directory it is given, which no link names: keep only the tree's.
  const used = new Map<string, MetadataNode>()
  for (const { cid } of lay.metadata) {
    const key = cid.toString()
    const node = nodes.get(key)
    if (node != null) used.set(key, node)
  }
  return {
    root,
    entryCid,
    name,
    isDirectory,
    nodes: used,
    layout: lay,
    contentLength: lay.total,
    sources: new Map(
      files.map((f) => [f.path, { path: f.source, position: f.position }])
    ),
  }
}

/**
 * Pass 2: the inner CAR's bytes, in layout order. Each leaf is read from its
 * first target and hashed again before it is emitted, and every other place
 * the leaf is used is read and compared with it. Once every leaf is read,
 * each file is read one byte past its planned size, so a file that grew
 * during pass 2 fails too. Throwing before the stream ends fails the encryption, so nothing changed
 * is ever uploaded.
 *
 * @param plan - The result of {@link planInnerCar}.
 * @param source - Reads the files' bytes.
 * @throws {InputError} `changed` when a file no longer matches pass 1, or `unreadable`.
 */
export async function* emitInnerCar(
  plan: InnerCarPlan,
  source: InputSource
): AsyncGenerator<Uint8Array> {
  yield plan.layout.header
  for (const { cid } of plan.layout.metadata) {
    const node = plan.nodes.get(cid.toString())
    if (node == null)
      throw new InputError('bad-entries', 'A metadata node vanished')
    yield encodeVarint(cid.bytes.length + node.bytes.length)
    yield cid.bytes
    yield node.bytes
  }
  const readAt = async (
    path: string,
    offset: number,
    length: number
  ): Promise<Uint8Array> => {
    const file = plan.sources.get(path)
    if (file == null) throw new InputError('bad-entries', 'A leaf has no file')
    try {
      return await source.read(file.path, offset, length)
    } catch (error) {
      throw entryError(
        'unreadable',
        file.position,
        `Cannot read an input file: ${errorCode(error)}`
      )
    }
  }
  const changed = (path: string): InputError =>
    changedError(plan.sources.get(path)?.position ?? 0)
  for (const leaf of plan.layout.leaves) {
    const [target, ...repeats] = leaf.targets
    if (target == null)
      throw new InputError('bad-entries', 'A leaf has no file')
    // A copy: the source may hand back a buffer it reuses, and these bytes must outlast the next read.
    // `new Uint8Array`, not `slice`: a Node Buffer's `slice` is a view.
    const bytes = new Uint8Array(
      await readAt(target.path, target.fileOffset, leaf.len)
    )
    if (bytes.length !== leaf.len) throw changed(target.path)
    // Every leaf comes from the importer's sha2-256 profile, never identity.
    if (
      leaf.cid.multihash.code !== SHA256_CODE ||
      !equalBytes(await sha256(bytes), leaf.cid.multihash.digest)
    ) {
      throw changed(target.path)
    }
    // A leaf the input repeats is emitted once: each other place must still hold the same bytes.
    for (const repeat of repeats) {
      const again = await readAt(repeat.path, repeat.fileOffset, leaf.len)
      if (!equalBytes(again, bytes)) throw changed(repeat.path)
    }
    yield encodeVarint(leaf.cid.bytes.length + leaf.len)
    yield leaf.cid.bytes
    yield bytes
  }
  // Every end is checked once every leaf is read, so a file that grows while another is read fails too.
  for (const [path, file] of plan.layout.files) {
    if ((await readAt(path, file.size, 1)).length > 0) throw changed(path)
  }
}

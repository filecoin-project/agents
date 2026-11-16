import {
  type FileHandle,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { CarBlockIterator } from '@ipld/car'
import * as DagPb from '@ipld/dag-pb'
import { CliError } from 'clipact'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import { ErrorCodes } from '../errors.ts'
import { fetchContent, outputExists } from './get.ts'
import { assertBlock, IDENTITY_CODE } from './pack.ts'

/**
 * `Accept` header for a trustless-gateway CAR whose blocks come depth-first,
 * parent before children, with every repeated block sent again. Curio serves
 * `/ipfs/{cid}` this way through frisbii.
 *
 * @see https://specs.ipfs.tech/http-gateways/trustless-gateway/#car-responses
 * @see https://github.com/ipld/frisbii
 */
export const DFS_CAR_ACCEPT =
  'application/vnd.ipld.car;version=1;order=dfs;dups=y'

/** Options for {@link downloadDag}. */
export type DownloadDagOptions = {
  /**
   * A trustless-gateway URL for the root, such as Curio's
   * `/ipfs/{rootCid}`, or a filecoin-api `/get/{rootCid}` URL that
   * redirects to one.
   */
  url: string
  rootCid: string
  /** File or directory to extract the root into; must be absent. */
  output: string
  /** Replace an existing file at `output`; a directory is never replaced. */
  overwrite?: boolean
  /** Error for a 404, such as content the provider has not indexed yet. */
  notFound?: () => CliError
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

/** Result of {@link downloadDag}. */
export type DownloadDagResult = {
  /** `folder` when the root is a UnixFS directory, else `file`. */
  kind: 'file' | 'folder'
  /** CAR bytes received. */
  size: number
  files: number
  /** URL the CAR came from, after redirects. */
  url: string
}

/** A file being written, fed by its blocks in order. */
type Sink = {
  handle: FileHandle
  path: string
  written: number
  expected: number
}

/** What a block is to the walk: a named entry, a file's chunk, or a HAMT shard. */
type Role =
  | { kind: 'entry'; path: string; root?: boolean }
  | { kind: 'chunk'; sink: Sink }
  | { kind: 'shard'; path: string }

/** One step of the walk: a block to expect next, or a file to close. */
type Frame = { cid: CID; role: Role } | { close: Sink }

/** A `verification_failed` error. */
function invalid(message: string): CliError {
  return new CliError({ code: ErrorCodes.verificationFailed, message })
}

/** An `unsafe_path` error. */
function unsafe(message: string): CliError {
  return new CliError({ code: ErrorCodes.unsafePath, message })
}

/**
 * Download a UnixFS DAG as a depth-first CAR stream and extract it into
 * `output` while it arrives, so no CAR is written to disk. Each block must
 * be the next one the walk from the root expects, and its bytes must hash
 * to its CID. The walk starts at `rootCid` and follows only links of blocks
 * already checked, so the extracted tree is exactly the root's. The tree is
 * written into `<output>.filecoin-partial`, then renamed into place.
 *
 * Supports UnixFS files, directories and HAMT-sharded directories, with
 * dag-pb and raw blocks. Symlinks and entry names that leave the output
 * directory are rejected with `unsafe_path`.
 *
 * @see https://specs.ipfs.tech/http-gateways/trustless-gateway/
 * @see https://specs.ipfs.tech/unixfs/
 */
export async function downloadDag(
  options: DownloadDagOptions
): Promise<DownloadDagResult> {
  const output = resolve(options.output)
  const existing = await stat(output).catch(() => undefined)
  if (existing && !(options.overwrite && existing.isFile())) {
    throw outputExists(options.output)
  }
  const root = CID.parse(options.rootCid)
  // Aborted when the walk fails, so the provider stops sending: leaving the
  // block loop does not cancel the body under the CAR iterator.
  const stop = new AbortController()
  const response = await fetchContent(options.url, {
    accept: DFS_CAR_ACCEPT,
    notFound: options.notFound,
    fetch: options.fetch,
    signal: options.signal
      ? AbortSignal.any([options.signal, stop.signal])
      : stop.signal,
  })
  const url = response.url || options.url
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('application/vnd.ipld.car')) {
    await response.body.cancel()
    throw invalid(`${url} returned ${type || 'no content type'}, not a CAR.`)
  }
  if (/order=(?!dfs)/.test(type) || /dups=n/.test(type)) {
    await response.body.cancel()
    throw invalid(
      `${url} returned ${type}, not a depth-first CAR with duplicates.`
    )
  }

  let size = 0
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.length
      yield chunk
    }
  }

  const tmp = `${output}.filecoin-partial`
  await rm(tmp, { recursive: true, force: true })
  await mkdir(dirname(output), { recursive: true })
  const walk = new DagWalk(root, tmp, (kind) => {
    if (kind === 'folder' && existing) throw outputExists(options.output)
  })
  try {
    const blocks = await CarBlockIterator.fromIterable(counted())
    const [headerRoot] = await blocks.getRoots()
    if (headerRoot && !root.equals(headerRoot)) {
      throw invalid(`CAR root is ${headerRoot}, expected ${root}.`)
    }
    for await (const block of blocks) {
      await walk.next(CID.decode(block.cid.bytes), block.bytes)
    }
    await walk.end()
    if (existing) await rm(output, { force: true })
    await rename(tmp, output)
    return { kind: walk.kind, size, files: walk.files, url }
  } catch (error) {
    await walk.abort()
    stop.abort()
    await rm(tmp, { recursive: true, force: true })
    throw error
  }
}

/**
 * The verifying walk of {@link downloadDag}: a stack of the blocks still
 * expected, in the depth-first order of the CAR.
 */
class DagWalk {
  /** Kind of the root, known once its block arrives. */
  kind: 'file' | 'folder' = 'file'
  files = 0
  readonly #target: string
  readonly #stack: Frame[]
  readonly #open = new Set<Sink>()
  readonly #onRoot: (kind: 'file' | 'folder') => void

  /** Start a walk that extracts `root` to `target`. */
  constructor(
    root: CID,
    target: string,
    onRoot: (kind: 'file' | 'folder') => void
  ) {
    this.#target = target
    this.#onRoot = onRoot
    this.#stack = [
      { cid: root, role: { kind: 'entry', path: target, root: true } },
    ]
  }

  /** Check and extract the next block of the stream. */
  async next(cid: CID, bytes: Uint8Array): Promise<void> {
    await this.#settle()
    // #settle leaves a block frame on top, or an empty stack.
    const frame = this.#stack.at(-1) as { cid: CID; role: Role } | undefined
    if (!frame?.cid.equals(cid)) {
      // A gateway may send an identity block that the walk read inline.
      if (cid.multihash.code === IDENTITY_CODE) return
      throw invalid(
        frame
          ? `Expected block ${frame.cid}, got ${cid}.`
          : `Unexpected block ${cid} after the end of the DAG.`
      )
    }
    this.#stack.pop()
    await assertBlock(cid, bytes)
    await this.#visit(frame.role, cid, bytes)
  }

  /** Finish the walk; fails if the stream ended before the DAG did. */
  async end(): Promise<void> {
    await this.#settle()
    const frame = this.#stack.at(-1)
    if (frame && !('close' in frame)) {
      throw invalid(`The CAR ended before block ${frame.cid}.`)
    }
  }

  /** Close any file left open by a failed walk. */
  async abort(): Promise<void> {
    await Promise.all([...this.#open].map((sink) => sink.handle.close()))
    this.#open.clear()
  }

  /**
   * Run the frames that need no block: close finished files, and read
   * identity blocks, whose bytes are in their CID.
   */
  async #settle(): Promise<void> {
    for (let frame = this.#stack.at(-1); frame; frame = this.#stack.at(-1)) {
      if ('close' in frame) {
        this.#stack.pop()
        await this.#close(frame.close)
      } else if (frame.cid.multihash.code === IDENTITY_CODE) {
        this.#stack.pop()
        await this.#visit(frame.role, frame.cid, frame.cid.multihash.digest)
      } else {
        return
      }
    }
  }

  /** Extract one checked block according to its role. */
  async #visit(role: Role, cid: CID, bytes: Uint8Array): Promise<void> {
    if (cid.code === Raw.code) {
      if (role.kind === 'chunk') return this.#write(role.sink, bytes)
      if (role.kind === 'shard') throw invalid(`Shard ${cid} is a raw block.`)
      this.#found(role, 'file')
      const sink = await this.#create(role.path, bytes.length)
      await this.#write(sink, bytes)
      return this.#close(sink)
    }
    if (cid.code !== DagPb.code) {
      throw invalid(
        `Block ${cid} has codec 0x${cid.code.toString(16)}, not UnixFS.`
      )
    }
    const node = DagPb.decode(bytes)
    if (!node.Data) throw invalid(`Block ${cid} has no UnixFS data.`)
    const unixfs = UnixFS.unmarshal(node.Data)
    const links = node.Links.map((link) => ({
      cid: CID.decode(link.Hash.bytes),
      name: link.Name ?? '',
    })).reverse()

    if (unixfs.type === 'file' || unixfs.type === 'raw') {
      if (role.kind === 'shard') throw invalid(`Shard ${cid} is a file.`)
      let sink: Sink
      if (role.kind === 'chunk') {
        sink = role.sink
      } else {
        this.#found(role, 'file')
        sink = await this.#create(role.path, Number(unixfs.fileSize()))
        this.#stack.push({ close: sink })
      }
      if (unixfs.data?.length) await this.#write(sink, unixfs.data)
      for (const link of links) {
        this.#stack.push({ cid: link.cid, role: { kind: 'chunk', sink } })
      }
      return
    }

    if (role.kind === 'chunk') {
      throw invalid(`File chunk ${cid} is a ${unixfs.type}.`)
    }
    if (unixfs.type === 'directory') {
      if (role.kind === 'shard') throw invalid(`Shard ${cid} is a directory.`)
      this.#found(role, 'folder')
      await mkdir(role.path, { recursive: true })
      for (const link of links) {
        this.#stack.push({
          cid: link.cid,
          role: { kind: 'entry', path: this.#child(role.path, link.name) },
        })
      }
      return
    }
    if (unixfs.type === 'hamt-sharded-directory') {
      if (role.kind === 'entry') {
        this.#found(role, 'folder')
        await mkdir(role.path, { recursive: true })
      }
      // Each link name starts with its bucket index in hex; a name of only
      // the index is a sub-shard of the same directory.
      const pad = ((unixfs.fanout ?? 256n) - 1n).toString(16).length
      for (const link of links) {
        this.#stack.push({
          cid: link.cid,
          role:
            link.name.length === pad
              ? { kind: 'shard', path: role.path }
              : {
                  kind: 'entry',
                  path: this.#child(role.path, link.name.slice(pad)),
                },
        })
      }
      return
    }
    if (unixfs.type === 'symlink') {
      throw unsafe(`Refusing to write the symlink ${cid}.`)
    }
    throw invalid(`Block ${cid} is an unsupported UnixFS ${unixfs.type}.`)
  }

  /** Record the root's kind, the first time an entry is the root. */
  #found(role: Role, kind: 'file' | 'folder'): void {
    if (role.kind === 'entry' && role.root) {
      this.kind = kind
      this.#onRoot(kind)
    }
  }

  /**
   * Path of the entry `name` in `dir`. Rejects an empty name, `.`, `..`, a
   * name with a path separator, and any path that resolves outside the
   * output.
   */
  #child(dir: string, name: string): string {
    if (
      name === '' ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      throw unsafe(`Refusing entry name ${JSON.stringify(name)}.`)
    }
    const path = resolve(dir, name)
    if (!path.startsWith(this.#target + sep)) {
      throw unsafe(`Refusing to write outside the output: ${path}`)
    }
    return path
  }

  /** Open a new file of the tree for writing. */
  async #create(path: string, expected: number): Promise<Sink> {
    const handle = await open(path, 'wx')
    const sink = { handle, path, written: 0, expected }
    this.#open.add(sink)
    this.files++
    return sink
  }

  /** Append bytes to a file, refusing more than its UnixFS size. */
  async #write(sink: Sink, bytes: Uint8Array): Promise<void> {
    sink.written += bytes.length
    if (sink.written > sink.expected) {
      throw invalid(`${sink.path} is larger than its UnixFS size.`)
    }
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await sink.handle.write(bytes, offset)
      offset += bytesWritten
    }
  }

  /** Close a finished file and check its size. */
  async #close(sink: Sink): Promise<void> {
    this.#open.delete(sink)
    await sink.handle.close()
    if (sink.written !== sink.expected) {
      throw invalid(
        `${sink.path} has ${sink.written} bytes, but its UnixFS size is ${sink.expected}.`
      )
    }
  }
}

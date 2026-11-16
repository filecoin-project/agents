import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import * as CarBufferWriter from '@ipld/car/buffer-writer'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import {
  type DirectoryCandidate,
  type FileCandidate,
  importer,
} from 'ipfs-unixfs-importer'
import { varint } from 'multiformats'
import { equals } from 'multiformats/bytes'
import type { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { invalidInput, sourceChanged } from '../errors.ts'
import { directoryCandidates, IMPORTER_OPTIONS, listEntries } from './pack.ts'

/** Multicodec of a UnixFS node (directory, HAMT shard, or file node). */
const DAG_PB = 0x70
/** Multicodec of a raw leaf. */
const RAW = 0x55

/**
 * The parts of a CID the DFS walk reads. Links decoded by `@ipld/dag-pb`
 * can be CIDs of another `multiformats` copy, so the walk takes this shape
 * instead of the class.
 */
type BlockCid = {
  code: number
  bytes: Uint8Array
  multihash: { code: number; digest: Uint8Array }
  toString(): string
}

/**
 * The DAG of a file or folder, from the first pass. UnixFS nodes keep their
 * bytes; raw leaves keep only their length and are read again from the
 * source in the second pass.
 */
type Dag = {
  root: BlockCid
  /** dag-pb block bytes by CID string. */
  nodes: Map<string, Uint8Array>
  /** Raw leaf lengths by CID string. */
  leaves: Map<string, number>
  /** Source file of each file's root block, by CID string. */
  sources: Map<string, string>
}

/** A block reached by the DFS walk, in the order it is written. */
type Visit =
  | { cid: BlockCid; bytes: Uint8Array }
  | { cid: BlockCid; source: string; offset: number; length: number }

/** Options for {@link planDirectory} and {@link planFile}. */
export type PackOptions = {
  /**
   * Largest CAR to plan, in bytes. Planning stops with `invalid_input` as
   * soon as the imported blocks pass it.
   */
  maxSize?: number | undefined
}

/** A CAR planned by {@link planDirectory} or {@link planFile}. */
export type DfsCar = {
  rootCid: CID
  /** Exact CAR size in bytes, header included. */
  size: number
  /** Files in the folder; 1 for a file. */
  files: number
  /** Distinct blocks in the CAR. */
  blocks: number
  /**
   * Write the CAR: a CARv1 header with the root, then every block once in
   * first-seen depth-first order from the root. UnixFS nodes come from
   * memory. Raw leaves are read from the source and checked against their
   * CIDs, and a mismatch or short read fails with `source_changed`. Each
   * call starts a new pass over the source.
   */
  stream(options?: {
    signal?: AbortSignal | undefined
  }): AsyncGenerator<Uint8Array<ArrayBuffer>>
}

/**
 * Plan a UnixFS CAR of a directory in DFS order, without writing it. The
 * first pass imports the directory with {@link directoryCandidates}. Only
 * UnixFS nodes stay in memory: directories, HAMT shards, and file nodes.
 */
export async function planDirectory(
  dir: string,
  options: PackOptions = {}
): Promise<DfsCar> {
  const root = resolve(dir)
  const name = basename(root)
  const { files, directories } = await listEntries(root)
  const paths = new Map(
    files.map((file) => [`${name}/${file.path}`, join(root, file.path)])
  )
  const candidates = directoryCandidates(root, name, files, directories)
  return await plan(dir, name, candidates, paths, files.length, options)
}

/**
 * Plan a UnixFS CAR of one file in DFS order, without writing it, with no
 * directory around the file. The root CID is the file's own: a raw block for
 * a file of one chunk, otherwise a UnixFS file node.
 */
export async function planFile(
  file: string,
  options: PackOptions = {}
): Promise<DfsCar> {
  const path = resolve(file)
  const name = basename(path)
  const candidates = [{ path: name, content: createReadStream(path) }]
  return await plan(file, name, candidates, new Map([[name, path]]), 1, options)
}

/** Bytes a block takes in a CAR: its length varint, CID, and bytes. */
function blockLength(cid: BlockCid, length: number): number {
  const total = cid.bytes.length + length
  return varint.encodingLength(total) + total
}

/**
 * First pass: import `candidates`, keep the UnixFS nodes, and measure the
 * CAR. `paths` maps each importer path of a file to its source. Past
 * `options.maxSize` bytes, the import stops with `invalid_input`.
 */
async function plan(
  source: string,
  name: string,
  candidates: Iterable<FileCandidate | DirectoryCandidate>,
  paths: Map<string, string>,
  files: number,
  options: PackOptions
): Promise<DfsCar> {
  const { maxSize } = options
  const tooLarge = () =>
    invalidInput(
      `The CAR of ${source} is larger than ${maxSize} bytes, the largest piece allowed.`,
      'path'
    )
  const nodes = new Map<string, Uint8Array>()
  const leaves = new Map<string, number>()
  // Blocks the importer writes, an upper bound of the CAR, for an early stop.
  let imported = 0
  const blockstore = {
    put(cid: CID, bytes: Uint8Array): Promise<CID> {
      const key = cid.toString()
      if (cid.code === DAG_PB) {
        if (nodes.has(key)) return Promise.resolve(cid)
        nodes.set(key, bytes)
      } else {
        if (leaves.has(key)) return Promise.resolve(cid)
        leaves.set(key, bytes.length)
      }
      imported += blockLength(cid, bytes.length)
      if (maxSize != null && imported > maxSize) {
        return Promise.reject(tooLarge())
      }
      return Promise.resolve(cid)
    },
  }

  const sources = new Map<string, string>()
  let rootCid: CID | undefined
  for await (const entry of importer(
    candidates,
    blockstore,
    IMPORTER_OPTIONS
  )) {
    const path = entry.path == null ? undefined : paths.get(entry.path)
    if (path) sources.set(entry.cid.toString(), path)
    if (entry.path === name) rootCid = entry.cid
  }
  if (!rootCid) throw new Error(`Packing ${source} produced no root.`)

  const dag: Dag = { root: rootCid, nodes, leaves, sources }
  // The walk, not the import, sizes the CAR: it skips any block the
  // importer wrote that the root does not reach.
  let size = headerLength(rootCid)
  let blocks = 0
  for (const visit of walk(dag)) {
    size += blockLength(
      visit.cid,
      'bytes' in visit ? visit.bytes.length : visit.length
    )
    blocks++
  }
  if (maxSize != null && size > maxSize) throw tooLarge()

  return {
    rootCid,
    size,
    files,
    blocks,
    stream: (streamOptions = {}) =>
      writeDfs(dag, source, size, streamOptions.signal),
  }
}

/** Length of a CARv1 header with one root. */
function headerLength(root: BlockCid): number {
  return CarBufferWriter.calculateHeaderLength([root.bytes.length])
}

/** A CARv1 header with `root` as its only root. */
function carHeader(root: CID): Uint8Array {
  const roots = [root]
  const length = CarBufferWriter.headerLength({ roots })
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(length), {
    roots,
  })
  return CarBufferWriter.close(writer)
}

/** A walk step: a block and where its file bytes start. */
type Frame = { cid: BlockCid; source: string | undefined; offset: number }

/**
 * Visit the DAG depth-first from the root, each block the first time it is
 * reached (the CARv1 "filecoin-deterministic" order, `dups=n`). A file
 * node's children start at the offsets its `blocksizes` give.
 *
 * @see https://ipld.io/specs/transport/car/carv1/#determinism
 * @see https://specs.ipfs.tech/http-gateways/trustless-gateway/#car-order-request-query-parameter
 */
function* walk(dag: Dag): Generator<Visit> {
  const seen = new Set<string>()
  const stack: Frame[] = [{ cid: dag.root, source: undefined, offset: 0 }]
  while (stack.length > 0) {
    const frame = stack.pop() as Frame
    const { cid } = frame
    const key = cid.toString()
    if (seen.has(key)) continue
    seen.add(key)
    // The root block of a file starts that file's bytes at offset 0.
    const fileSource = dag.sources.get(key)
    const source = fileSource ?? frame.source
    const offset = fileSource ? 0 : frame.offset

    if (cid.code === RAW) {
      const length = dag.leaves.get(key)
      if (length == null || source == null) {
        throw new Error(`Raw block ${key} has no source file.`)
      }
      yield { cid, source, offset, length }
      continue
    }
    if (cid.code !== DAG_PB) {
      throw new Error(`Unexpected codec 0x${cid.code.toString(16)} in ${key}.`)
    }
    const bytes = dag.nodes.get(key)
    if (!bytes) throw new Error(`Block ${key} is missing from the DAG.`)
    yield { cid, bytes }

    const node = dagPb.decode(bytes)
    const unixfs = node.Data ? UnixFS.unmarshal(node.Data) : undefined
    const children: Frame[] = []
    if (unixfs?.type === 'file' || unixfs?.type === 'raw') {
      // Inline data, if any, comes before the children's bytes.
      let at = offset + (unixfs.data?.length ?? 0)
      node.Links.forEach((link, index) => {
        children.push({ cid: link.Hash, source, offset: at })
        at += Number(unixfs.blockSizes[index] ?? 0n)
      })
    } else {
      for (const link of node.Links) {
        children.push({ cid: link.Hash, source: undefined, offset: 0 })
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index] as Frame)
    }
  }
}

/** Output chunks are batched up to this size before they are yielded. */
const BATCH = 1024 * 1024

/**
 * Raw leaves read ahead of the output, by count and by bytes. Reading small
 * files one at a time spends most of the pass opening them.
 */
const READ_AHEAD = { blocks: 64, bytes: 16 * 1024 * 1024 }

/**
 * Second pass: write the CAR of `dag` in DFS order. Raw leaves are read
 * ahead, up to {@link READ_AHEAD}, and written in walk order. Small blocks
 * are batched into chunks of up to {@link BATCH} bytes; a raw leaf of that
 * size is read straight into its own chunk after its length and CID.
 */
async function* writeDfs(
  dag: Dag,
  source: string,
  size: number,
  signal: AbortSignal | undefined
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const changed = (detail: string) =>
    sourceChanged(
      `${source} changed while it was being packed: ${detail}`,
      source
    )
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let written = 0
  const flush = (): Uint8Array<ArrayBuffer> => {
    const chunk = new Uint8Array(pendingBytes)
    let at = 0
    for (const part of pending) {
      chunk.set(part, at)
      at += part.length
    }
    pending = []
    pendingBytes = 0
    written += chunk.length
    return chunk
  }

  const ahead: { block: Promise<Uint8Array<ArrayBuffer>>; length: number }[] =
    []
  let aheadBytes = 0
  /** Take the oldest block read ahead and return the chunks it completes. */
  async function next(): Promise<Uint8Array<ArrayBuffer>[]> {
    const first = ahead.shift() as (typeof ahead)[number]
    aheadBytes -= first.length
    const block = await first.block
    const chunks: Uint8Array<ArrayBuffer>[] = []
    if (pendingBytes + block.length > BATCH && pendingBytes > 0) {
      chunks.push(flush())
    }
    if (block.length >= BATCH) {
      written += block.length
      chunks.push(block)
    } else {
      pending.push(block)
      pendingBytes += block.length
    }
    return chunks
  }

  pending.push(carHeader(dag.root as CID))
  pendingBytes += pending[0]?.length ?? 0
  for (const visit of walk(dag)) {
    signal?.throwIfAborted()
    const block = encodeBlock(visit, changed)
    // A read that fails before its turn is handled when it is awaited.
    block.catch(() => undefined)
    const length = 'bytes' in visit ? 0 : visit.length
    ahead.push({ block, length })
    aheadBytes += length
    while (
      ahead.length > READ_AHEAD.blocks ||
      (aheadBytes > READ_AHEAD.bytes && ahead.length > 1)
    ) {
      yield* await next()
    }
  }
  while (ahead.length > 0) yield* await next()
  if (pendingBytes > 0) yield flush()
  if (written !== size) {
    throw new Error(`Wrote ${written} bytes of a ${size}-byte CAR.`)
  }
}

/**
 * Encode a visited block as it appears in a CAR: its length varint, CID,
 * and bytes. A raw leaf is read from its source and checked against its
 * CID; a short read or a mismatch means the source changed.
 */
async function encodeBlock(
  visit: Visit,
  changed: (detail: string) => Error
): Promise<Uint8Array<ArrayBuffer>> {
  const { cid } = visit
  const length = 'bytes' in visit ? visit.bytes.length : visit.length
  const total = cid.bytes.length + length
  const prefixLength = varint.encodingLength(total) + cid.bytes.length
  const block = new Uint8Array(prefixLength + length)
  varint.encodeTo(total, block, 0)
  block.set(cid.bytes, prefixLength - cid.bytes.length)
  if ('bytes' in visit) {
    block.set(visit.bytes, prefixLength)
    return block
  }

  if (cid.multihash.code !== sha256.code) {
    throw new Error(`Unexpected multihash in ${cid}.`)
  }
  const handle = await open(visit.source, 'r').catch((error: unknown) => {
    throw changed(`cannot open ${visit.source}: ${String(error)}`)
  })
  try {
    await readFully(handle, block, prefixLength, visit, changed)
  } finally {
    await handle.close()
  }
  const digest = createHash('sha256')
    .update(block.subarray(prefixLength))
    .digest()
  if (!equals(digest, cid.multihash.digest)) {
    throw changed(
      `bytes ${visit.offset}-${visit.offset + length} of ${visit.source} no longer match block ${cid}`
    )
  }
  return block
}

/**
 * Read `visit.length` bytes at `visit.offset` into `target` from
 * `targetOffset`. A short read means the file shrank.
 */
async function readFully(
  handle: FileHandle,
  target: Uint8Array,
  targetOffset: number,
  visit: { source: string; offset: number; length: number },
  changed: (detail: string) => Error
): Promise<void> {
  let done = 0
  while (done < visit.length) {
    const { bytesRead } = await handle.read(
      target,
      targetOffset + done,
      visit.length - done,
      visit.offset + done
    )
    if (bytesRead === 0) {
      throw changed(`${visit.source} is shorter than when it was imported`)
    }
    done += bytesRead
  }
}

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decode as cborDecode, encode as cborEncode } from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { create as createDigest } from 'multiformats/hashes/digest'
import { identity } from 'multiformats/hashes/identity'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  carHeader,
  DAG_PB_CODEC,
  DEFAULT_MAX_METADATA_BYTES,
  emitInnerCar,
  encodeVarint,
  type InnerCarPlan,
  isUnsafeName,
  layout,
  MAX_DEPTH,
  planInnerCar,
  RAW_CODEC,
  type StreamOptions,
  unpackInnerCar,
} from '../src/car/index.ts'
import { feeFits } from '../src/car/pack.ts'
import { InnerCarError, InputError } from '../src/errors.ts'
import { readVarint } from '../src/internal/car-blocks.ts'
import {
  collect,
  concat,
  type MemoryTree,
  memoryInput,
  memorySink,
  randomBytes,
  sameBytes,
  text,
} from './helpers.ts'

const MiB = 1024 * 1024
type Block = { cid: CID; bytes: Uint8Array }

/** A CARv1 of `blocks` in the given order. */
function car(root: CID | CID[], blocks: readonly Block[]): Uint8Array {
  const parts: Uint8Array[] = [
    Array.isArray(root) ? multiRootHeader(root) : carHeader(root),
  ]
  for (const { cid, bytes } of blocks)
    parts.push(encodeVarint(cid.bytes.length + bytes.length), cid.bytes, bytes)
  return concat(parts)
}

/** A CARv1 header with several roots, which the inner CAR never has. */
function multiRootHeader(roots: CID[]): Uint8Array {
  const body = cborEncode({ roots, version: 1 })
  return concat([encodeVarint(body.length), body])
}

/** Plan `tree` and return the plan, the emitted inner CAR, and its blocks by CID string. */
async function packed(tree: MemoryTree): Promise<{
  plan: InnerCarPlan
  bytes: Uint8Array
  blocks: Map<string, Block>
}> {
  const { input, source } = memoryInput(tree)
  const plan = await planInnerCar(input, source)
  const bytes = await collect(emitInnerCar(plan, source))
  const blocks = new Map<string, Block>()
  for (const node of plan.nodes.values()) blocks.set(node.cid.toString(), node)
  for (const leaf of plan.layout.leaves) {
    blocks.set(leaf.cid.toString(), {
      cid: leaf.cid,
      bytes: bytes.slice(leaf.dataOffset, leaf.dataOffset + leaf.len),
    })
  }
  return { plan, bytes, blocks }
}

/** A deterministic buffer of `size` bytes. */
const filled = (size: number, seed: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff)

/** A dag-pb block. */
async function pbBlock(node: dagPb.PBNode): Promise<Block> {
  const bytes = dagPb.encode(node)
  return { cid: CID.createV1(DAG_PB_CODEC, await sha256.digest(bytes)), bytes }
}

/** A raw block. */
async function rawBlock(bytes: Uint8Array): Promise<Block> {
  return { cid: CID.createV1(RAW_CODEC, await sha256.digest(bytes)), bytes }
}

const dirData = new UnixFS({ type: 'directory' }).marshal()

/** Expect `unpackInnerCar(bytes)` to fail with `code`, naming no entry and no CID. */
async function refuses(
  bytes: Uint8Array,
  code: string,
  secret = 'secret'
): Promise<void> {
  await assert.rejects(
    unpackInnerCar([bytes], memorySink()),
    (error: unknown) => {
      assert.ok(error instanceof InnerCarError, String(error))
      assert.equal(error.code, code)
      assert.ok(!error.message.includes(secret), error.message)
      assert.ok(!/baf[a-z0-9]{20,}/.test(error.message), error.message)
      return true
    }
  )
}

describe('planInnerCar and emitInnerCar', () => {
  test('wrap the input in an anonymous directory whose one link is the input', async () => {
    const { plan, bytes } = await packed({ 'a.txt': 'hello' })
    assert.equal(plan.name, 'a.txt')
    assert.equal(plan.isDirectory, false)
    assert.equal(bytes.length, plan.contentLength)
    const wrapper = dagPb.decode(
      plan.nodes.get(plan.root.toString())?.bytes ?? new Uint8Array()
    )
    assert.deepEqual(
      wrapper.Links.map((l) => [l.Name, l.Hash.toString()]),
      [['a.txt', plan.entryCid.toString()]]
    )
  })

  test('list every dag-pb node first, breadth-first, then every leaf in file order', async () => {
    const { plan } = await packed({
      photos: null,
      'photos/a.jpg': filled(1.5 * MiB, 1),
      'photos/b.jpg': filled(1.5 * MiB, 2),
    })
    const { metadata, leaves } = plan.layout
    assert.equal(metadata.length, 4) // wrapper, photos, a.jpg, b.jpg
    assert.ok((metadata.at(-1)?.offset ?? 0) < (leaves[0]?.offset ?? 0))
    assert.deepEqual(
      leaves.map((l) => l.targets.map((t) => `${t.path}@${t.fileOffset}`)),
      [
        ['photos/a.jpg@0'],
        [`photos/a.jpg@${MiB}`],
        ['photos/b.jpg@0'],
        [`photos/b.jpg@${MiB}`],
      ]
    )
  })

  // Browsers have no heap counter.
  test('unpack input cut into 1-byte pieces without keeping an object per piece', {
    skip: typeof globalThis.process?.memoryUsage !== 'function',
  }, async () => {
    const file = filled(512 * 1024, 3)
    const { bytes } = await packed({ 'one.bin': file })
    // The heap's peak while `consume` reads views of one buffer, as a reader that hands its buffer out piece by piece.
    const peak = async (
      consume: (pieces: Iterable<Uint8Array>) => Promise<unknown>
    ): Promise<number> => {
      const base = process.memoryUsage().heapUsed
      let most = 0
      await consume(
        (function* () {
          for (let i = 0; i < bytes.length; i++) {
            if (i % 4096 === 0)
              most = Math.max(most, process.memoryUsage().heapUsed - base)
            yield bytes.subarray(i, i + 1)
          }
        })()
      )
      return most
    }
    // The pieces alone leave garbage: only what the reader adds to it counts.
    const garbage = await peak(async (pieces) => {
      for await (const _ of pieces);
    })
    const sink = memorySink()
    const unpacking = await peak((pieces) => unpackInnerCar(pieces, sink))
    assert.ok(sameBytes(file, sink.files.get('one.bin') ?? new Uint8Array()))
    // A buffer per piece holds about 300 MiB of objects for this one leaf.
    assert.ok(
      unpacking < garbage + 64 * MiB,
      `heap grew by ${unpacking} bytes, ${garbage} for the pieces alone`
    )
  })

  test('emit a repeated chunk once, with a target for each place it belongs', async () => {
    const chunk = filled(MiB, 7)
    const { plan, bytes } = await packed({
      'twice.bin': concat([chunk, chunk]),
    })
    assert.equal(plan.layout.leaves.length, 1)
    assert.deepEqual(plan.layout.leaves[0]?.targets, [
      { path: 'twice.bin', fileOffset: 0 },
      { path: 'twice.bin', fileOffset: MiB },
    ])
    const sink = memorySink()
    await unpackInnerCar([bytes], sink)
    assert.ok(
      sameBytes(
        concat([chunk, chunk]),
        sink.files.get('twice.bin') ?? new Uint8Array()
      )
    )
  })

  test('refuse unsafe names, naming the entry by position only', async () => {
    for (const name of ['a\\b', '..', '.']) {
      const { input, source } = memoryInput({
        secret: null,
        [`secret/${name}`]: 'x',
      })
      await assert.rejects(planInnerCar(input, source), (error: unknown) => {
        assert.ok(error instanceof InputError)
        assert.equal(error.code, 'unsafe-name')
        assert.match(error.message, /entry #1/)
        assert.ok(!error.message.includes('secret'))
        return true
      })
    }
    const { input, source } = memoryInput({ 'secret:x': 'x' })
    await assert.rejects(planInnerCar(input, source, { windows: true }), {
      code: 'unsafe-name',
    })
    await planInnerCar(input, source)
  })

  test('name the wrapper entry as the caller says, and refuse an unsafe one', async () => {
    const { source } = memoryInput({ a: null, 'a/x': 'x' })
    const plan = await planInnerCar(
      {
        type: 'directory',
        name: 'photos',
        entries: [{ type: 'file', path: 'x', size: 1 }],
      },
      { ...source, stream: (_path, options) => source.stream('x', options) }
    )
    const wrapper = dagPb.decode(
      plan.nodes.get(plan.root.toString())?.bytes ?? new Uint8Array()
    )
    assert.deepEqual(
      wrapper.Links.map((l) => l.Name),
      ['photos']
    )
    for (const name of ['', '..', 'a/b', 'a\\b']) {
      await assert.rejects(
        planInnerCar({ type: 'file', name, size: 1 }, source),
        {
          code: 'unsafe-name',
        }
      )
    }
  })

  test('refuse an entry listed twice, or a file that changed between passes', async () => {
    const { source } = memoryInput({ a: null, 'a/x': 'x' })
    await assert.rejects(
      planInnerCar(
        {
          type: 'directory',
          name: 'a',
          entries: [
            { type: 'file', path: 'x', size: 1 },
            { type: 'file', path: 'x', size: 1 },
          ],
        },
        source
      ),
      { code: 'bad-entries', message: /entry #2/ }
    )
    const tree: MemoryTree = { secret: 'before' }
    const input = memoryInput(tree)
    const plan = await planInnerCar(input.input, input.source)
    tree.secret = 'after!'
    await assert.rejects(collect(emitInnerCar(plan, input.source)), {
      code: 'changed',
      message: /entry #1/,
    })
  })

  test('refuse a name that starts with U+FEFF before reading it', async () => {
    const { input, source } = memoryInput({
      d: null,
      'd/\uFEFFreport.txt': 'secret',
    })
    await assert.rejects(planInnerCar(input, source), {
      code: 'unsafe-name',
      message: /entry #1/,
    })
  })

  test('stop reading a file in pass 1 at the first chunk past its listed size', async () => {
    let pulled = 0
    let closed = false
    function* chunks() {
      try {
        for (let i = 0; i < 8; i++) {
          pulled++
          yield new Uint8Array(MiB)
        }
      } finally {
        closed = true
      }
    }
    const source = {
      async *stream() {
        for await (const chunk of chunks()) yield chunk
      },
      read: () => Promise.resolve(new Uint8Array(0)),
    }
    await assert.rejects(
      planInnerCar({ type: 'file', name: 'grew.log', size: 6 }, source),
      { code: 'changed', message: /entry #1/ }
    )
    assert.equal(pulled, 1)
    assert.ok(closed)
  })

  test('stop reading sibling files when pass 1 fails', async () => {
    let closed = false
    // A file whose read never finishes on its own, as a stalled network read; return() ends it, as a Node stream's does.
    const stalled = (): AsyncIterator<Uint8Array> => {
      let end = (): void => undefined
      return {
        next: () =>
          new Promise((resolve) => {
            end = () => resolve({ done: true, value: undefined })
          }),
        return: () => {
          closed = true
          end()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    }
    const source = {
      stream(path: string) {
        if (path === 'slow') return { [Symbol.asyncIterator]: stalled }
        return (async function* () {
          // Let the slow file start first.
          await new Promise((resolve) => setTimeout(resolve, 10))
          yield new Uint8Array(100)
        })()
      },
      read: () => Promise.resolve(new Uint8Array(0)),
    }
    await assert.rejects(
      planInnerCar(
        {
          type: 'directory',
          name: 'd',
          entries: [
            { type: 'file', path: 'grew', size: 1 },
            { type: 'file', path: 'slow', size: 1 },
          ],
        },
        source
      ),
      { code: 'changed' }
    )
    assert.ok(closed, 'the slow file is closed')
  })

  test('stop every sibling and keep the error when a cleanup throws, or an earlier file stalls', async () => {
    const closed: string[] = []
    const stalled = (name: string, cleanup?: () => void) => () => {
      let end = (): void => undefined
      return {
        next: () =>
          new Promise<IteratorResult<Uint8Array>>((resolve) => {
            end = () => resolve({ done: true, value: undefined })
          }),
        return: () => {
          closed.push(name)
          end()
          cleanup?.()
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    }
    const source = {
      stream(path: string): AsyncIterable<Uint8Array> {
        if (path === 'a-throws')
          return {
            [Symbol.asyncIterator]: stalled(path, () => {
              throw new Error('cleanup failed')
            }),
          }
        if (path === 'b-slow') return { [Symbol.asyncIterator]: stalled(path) }
        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 10))
          yield new Uint8Array(100)
        })()
      },
      read: () => Promise.resolve(new Uint8Array(0)),
    }
    // The stalled files come first: the importer waits on them before it sees the growth.
    await assert.rejects(
      planInnerCar(
        {
          type: 'directory',
          name: 'd',
          entries: [
            { type: 'file', path: 'a-throws', size: 1 },
            { type: 'file', path: 'b-slow', size: 1 },
            { type: 'file', path: 'c-grew', size: 1 },
          ],
        },
        source
      ),
      { code: 'changed', message: /entry #3/ }
    )
    assert.deepEqual(closed.sort(), ['a-throws', 'b-slow'])
  })

  test('abort a stalled async-generator read when another file fails in pass 1', {
    timeout: 5000,
  }, async () => {
    let aborted = false
    const source = {
      stream(
        path: string,
        { signal }: StreamOptions
      ): AsyncIterable<Uint8Array> {
        if (path === 'a-slow') {
          // A generator's return() waits behind its pending next(): only the signal ends this read.
          return (async function* () {
            await new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true
                reject(signal.reason)
              })
            })
            yield new Uint8Array(1)
          })()
        }
        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 10))
          yield new Uint8Array(100)
        })()
      },
      read: () => Promise.resolve(new Uint8Array(0)),
    }
    await assert.rejects(
      planInnerCar(
        {
          type: 'directory',
          name: 'd',
          entries: [
            { type: 'file', path: 'a-slow', size: 1 },
            { type: 'file', path: 'b-grew', size: 1 },
          ],
        },
        source
      ),
      { code: 'changed', message: /entry #2/ }
    )
    assert.ok(aborted, 'the stalled read saw the abort')
  })

  test('abort before waiting on the cleanup of a file that grew', {
    timeout: 5000,
  }, async () => {
    let aborted = false
    const source = {
      stream(
        _path: string,
        { signal }: StreamOptions
      ): AsyncIterable<Uint8Array> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.resolve({ done: false, value: new Uint8Array(2) }),
            // A cleanup that ends only once the read is aborted, as one that waits on its own pending request.
            return: () =>
              new Promise<IteratorResult<Uint8Array>>((resolve) => {
                const done = (): void => {
                  aborted = true
                  resolve({ done: true, value: undefined })
                }
                if (signal.aborted) done()
                else signal.addEventListener('abort', done)
              }),
          }),
        }
      },
      read: () => Promise.resolve(new Uint8Array(0)),
    }
    await assert.rejects(
      planInnerCar({ type: 'file', name: 'f', size: 1 }, source),
      { code: 'changed' }
    )
    assert.ok(aborted)
  })

  test('keep the entry position when a source throws as it opens a file', async () => {
    const source = {
      stream(): AsyncIterable<Uint8Array> {
        throw Object.assign(new Error('ENOENT: /private/secret'), {
          code: 'ENOENT',
        })
      },
      read: () => Promise.resolve(new Uint8Array(0)),
    }
    await assert.rejects(
      planInnerCar({ type: 'file', name: 'gone', size: 1 }, source),
      { code: 'unreadable', message: /ENOENT \(entry #1\)/ }
    )
  })

  test('pack and unpack an empty root folder', async () => {
    const { input, source } = memoryInput({ empty: null })
    const plan = await planInnerCar(input, source)
    assert.equal(plan.name, 'empty')
    const sink = memorySink()
    assert.deepEqual(await unpackInnerCar(emitInnerCar(plan, source), sink), {
      name: 'empty',
      kind: 'directory',
      files: 0,
      dirs: 1,
      bytes: 0,
    })
  })

  test('refuse an upload FEE could not encode, past 64 GiB with its tags and header', () => {
    const max = 64 * 1024 ** 3
    assert.equal(feeFits(max - 300 * 1024 * 1024), true)
    assert.equal(feeFits(max - 3 * MiB), false)
  })

  test('import at most a few files at once in pass 1', async () => {
    let open = 0
    let most = 0
    const tree: MemoryTree = { d: null }
    for (let i = 0; i < 40; i++) tree[`d/${i}`] = filled(1000, i)
    const { input, source } = memoryInput(tree)
    const counting = {
      ...source,
      async *stream(path: string, options: StreamOptions) {
        open++
        most = Math.max(most, open)
        try {
          yield* source.stream(path, options)
        } finally {
          open--
        }
      },
    }
    await planInnerCar(input, counting)
    assert.ok(most <= 4, `${most} files open at once`)
  })

  test('refuse an entry under a file, in either order', async () => {
    const { source } = memoryInput({ a: null, 'a/x': 'x' })
    const file = { type: 'file', path: 'x', size: 1 } as const
    const under = { type: 'file', path: 'x/y', size: 1 } as const
    for (const [entries, position] of [
      [[file, under], 2],
      [[under, file], 1],
      [[file, { type: 'directory', path: 'x/d' } as const], 2],
    ] as const) {
      await assert.rejects(
        planInnerCar({ type: 'directory', name: 'a', entries }, source),
        { code: 'bad-entries', message: new RegExp(`entry #${position}\\b`) }
      )
    }
  })

  test('refuse an input over the cap before hashing it', async () => {
    const { input, source } = memoryInput({ 'a.bin': filled(10_000, 1) })
    let streamed = false
    const watched = {
      ...source,
      stream: (p: string, options: StreamOptions) => {
        streamed = true
        return source.stream(p, options)
      },
    }
    await assert.rejects(planInnerCar(input, watched, { maxBytes: 9_000 }), {
      code: 'too-large',
    })
    assert.equal(streamed, false)
  })

  test('the layout matches the emitted bytes at every offset', async () => {
    const { plan, bytes } = await packed({
      d: null,
      'd/x': filled(2.5 * MiB, 3),
      'd/y': 'y',
    })
    const again = layout(plan.root, plan.nodes)
    assert.equal(again.total, bytes.length)
    for (const leaf of again.leaves) {
      const block = bytes.slice(leaf.dataOffset, leaf.dataOffset + leaf.len)
      assert.deepEqual(
        (await sha256.digest(block)).digest,
        leaf.cid.multihash.digest
      )
    }
  })
})

describe('layout limits and the file index', () => {
  test('index each file by its leaves, in file order', async () => {
    const big = new Uint8Array(randomBytes(2.5 * MiB))
    const { plan, bytes } = await packed({ d: null, 'd/x': big, 'd/y': 'y' })
    const x = plan.layout.files.get('d/x')
    assert.equal(x?.size, big.length)
    assert.deepEqual(
      x?.leaves.map((l) => l.fileOffset),
      [0, MiB, 2 * MiB]
    )
    const rebuilt = concat(
      (x?.leaves ?? []).map(({ leaf, len }) =>
        bytes.subarray(leaf.dataOffset, leaf.dataOffset + len)
      )
    )
    assert.ok(sameBytes(rebuilt, big))
  })

  test('stop a DAG that links one child many times', async () => {
    const leaf = await rawBlock(new Uint8Array([1]))
    const fanOut = async (child: Block, size: number): Promise<Block> =>
      pbBlock({
        Data: new UnixFS({
          type: 'file',
          blockSizes: Array.from({ length: 1000 }, () => BigInt(size)),
        }).marshal(),
        Links: Array.from({ length: 1000 }, () => ({
          Hash: child.cid,
          Tsize: size,
        })),
      })
    const inner = await fanOut(leaf, 1)
    const outer = await fanOut(inner, 1000)
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: outer.cid, Tsize: 1 }],
    })
    // About 120 KB of CAR, and a million paths to walk.
    await refuses(
      car(wrapper.cid, [wrapper, outer, inner, leaf]),
      'layout-limit'
    )
  })

  test('stop shared subtrees whose paths add up past the path budget', async () => {
    // Three levels of 64 directories with 1,000-byte names, each level linking one shared node:
    // under 1 MB of CAR and the visit budget, but 262,144 paths of about 3,000 bytes.
    const names = Array.from({ length: 64 }, (_, i) =>
      `${String(i).padStart(2, '0')}`.padEnd(1000, 'n')
    )
    const level = async (child: Block): Promise<Block> =>
      pbBlock({
        Data: dirData,
        Links: names.map((Name) => ({ Name, Hash: child.cid, Tsize: 1 })),
      })
    const empty = await pbBlock({ Data: dirData, Links: [] })
    const third = await level(empty)
    const second = await level(third)
    const first = await level(second)
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: first.cid, Tsize: 1 }],
    })
    const bytes = car(wrapper.cid, [wrapper, first, second, third, empty])
    await refuses(bytes, 'layout-limit')
    const small = await packed({ d: null, 'd/a': 'a', 'd/b': 'b' })
    // `d`, `d/a`, and `d/b`: 7 bytes of path.
    await assert.rejects(
      unpackInnerCar([small.bytes], memorySink(), { maxTotalPathBytes: 6 }),
      { code: 'layout-limit' }
    )
    await unpackInnerCar([small.bytes], memorySink(), { maxTotalPathBytes: 7 })
  })

  test('refuse a limit that is not a whole number of at least 0', async () => {
    const { bytes } = await packed({ 'a.txt': 'a' })
    for (const options of [
      { maxVisits: Number.NaN },
      { maxEntries: -1 },
      { maxTotalPathBytes: 1.5 },
      { maxMetadataBytes: Number.NaN },
      { maxOutputBytes: -1 },
    ]) {
      await assert.rejects(
        unpackInnerCar([bytes], memorySink(), options),
        RangeError,
        JSON.stringify(options)
      )
    }
    await unpackInnerCar([bytes], memorySink(), {
      maxEntries: Number.POSITIVE_INFINITY,
    })
  })

  test('refuse a leaf over the profile chunk size', async () => {
    const big = await rawBlock(new Uint8Array(1024 * 1024 + 1))
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: big.cid, Tsize: big.bytes.length }],
    })
    await refuses(car(wrapper.cid, [wrapper, big]), 'not-unixfs')
  })

  test('refuse a long name or path, and past maxEntries or maxMetadataBytes', async () => {
    const leaf = await rawBlock(new Uint8Array([1]))
    const longName = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'n'.repeat(1025), Hash: leaf.cid, Tsize: 1 }],
    })
    await refuses(car(longName.cid, [longName, leaf]), 'layout-limit')

    // Five directories of 1,000-byte names: every name is fine, the path is over 4,096 bytes.
    const chain: Block[] = [leaf]
    for (let i = 0; i < 5; i++) {
      const child = chain[0] as Block
      chain.unshift(
        await pbBlock({
          Data: dirData,
          Links: [{ Name: 'n'.repeat(1000), Hash: child.cid, Tsize: 1 }],
        })
      )
    }
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'd', Hash: (chain[0] as Block).cid, Tsize: 1 }],
    })
    await refuses(car(wrapper.cid, [wrapper, ...chain]), 'layout-limit')

    const { bytes } = await packed({ d: null, 'd/a': 'a', 'd/b': 'b' })
    await assert.rejects(
      unpackInnerCar([bytes], memorySink(), { maxEntries: 2 }),
      { code: 'layout-limit' }
    )
    await assert.rejects(
      unpackInnerCar([bytes], memorySink(), { maxMetadataBytes: 10 }),
      { code: 'layout-limit' }
    )
    await unpackInnerCar([bytes], memorySink(), { maxEntries: 3 })
  })
})

describe('unpackInnerCar', () => {
  test('refuses a depth-first CAR: a dag-pb node after the first leaf', async () => {
    const { plan, blocks } = await packed({
      secret: null,
      'secret/a': filled(1.5 * MiB, 1),
      'secret/b': filled(1.5 * MiB, 2),
    })
    const get = (cid: CID): Block => blocks.get(cid.toString()) as Block
    // Each node right before its children, as dfs-car.ts writes it.
    const dfs: Block[] = []
    const walk = (cid: CID): void => {
      const block = get(cid)
      dfs.push(block)
      if (cid.code === DAG_PB_CODEC)
        for (const link of dagPb.decode(block.bytes).Links) walk(link.Hash)
    }
    walk(plan.root)
    await refuses(car(plan.root, dfs), 'not-metadata-first')
  })

  test('refuses leaves out of order', async () => {
    const { plan, blocks } = await packed({
      secret: null,
      'secret/a': filled(MiB, 1),
      'secret/b': filled(MiB, 2),
    })
    const nodes = plan.layout.metadata.map(
      (m) => blocks.get(m.cid.toString()) as Block
    )
    const leaves = plan.layout.leaves
      .map((l) => blocks.get(l.cid.toString()) as Block)
      .reverse()
    await refuses(car(plan.root, [...nodes, ...leaves]), 'out-of-order')
  })

  test('refuses a cut CAR and a missing leaf, and a missing node as out of order', async () => {
    const { plan, bytes, blocks } = await packed({
      secret: null,
      'secret/a': filled(MiB, 1),
      'secret/b': 'b',
    })
    await refuses(bytes.slice(0, bytes.length - 10), 'truncated')
    const nodes = plan.layout.metadata.map(
      (m) => blocks.get(m.cid.toString()) as Block
    )
    const leaves = plan.layout.leaves.map(
      (l) => blocks.get(l.cid.toString()) as Block
    )
    await refuses(
      car(plan.root, [...nodes, ...leaves.slice(0, -1)]),
      'truncated'
    )
    await refuses(
      car(plan.root, [...nodes.slice(0, -1), ...leaves]),
      'not-metadata-first'
    )
  })

  test('refuses a leaf or a node whose bytes do not match its CID', async () => {
    const { plan, blocks } = await packed({ secret: null, 'secret/a': 'aaaa' })
    const nodes = plan.layout.metadata.map(
      (m) => blocks.get(m.cid.toString()) as Block
    )
    const [leaf] = plan.layout.leaves.map(
      (l) => blocks.get(l.cid.toString()) as Block
    )
    assert.ok(leaf != null)
    await refuses(
      car(plan.root, [
        ...nodes,
        { cid: leaf.cid, bytes: new TextEncoder().encode('aaab') },
      ]),
      'block-mismatch'
    )
    const [wrapper, ...rest] = nodes as [Block, ...Block[]]
    const forged = {
      cid: wrapper.cid,
      bytes: dagPb.encode({ Data: dirData, Links: [] }),
    }
    await refuses(car(plan.root, [forged, ...rest, leaf]), 'block-mismatch')
  })

  test('refuses an unsafe name inside the CAR before the sink sees anything', async () => {
    for (const name of ['..', 'a/b', 'a\\b', '']) {
      const leaf = await rawBlock(new TextEncoder().encode('x'))
      const inner = await pbBlock({
        Data: dirData,
        Links: [{ Name: name, Hash: leaf.cid, Tsize: 1 }],
      })
      const wrapper = await pbBlock({
        Data: dirData,
        Links: [{ Name: 'secret', Hash: inner.cid, Tsize: 10 }],
      })
      const sink = memorySink()
      await assert.rejects(
        unpackInnerCar([car(wrapper.cid, [wrapper, inner, leaf])], sink),
        { code: 'unsafe-name' }
      )
      assert.equal(sink.tree, undefined)
    }
  })

  test('refuses a wrapper with other than one entry, several roots, another hash, or a symlink', async () => {
    const a = await rawBlock(new TextEncoder().encode('a'))
    const two = await pbBlock({
      Data: dirData,
      Links: [
        { Name: 'x', Hash: a.cid, Tsize: 1 },
        { Name: 'y', Hash: a.cid, Tsize: 1 },
      ],
    })
    await refuses(car(two.cid, [two, a]), 'not-one-entry')
    await refuses(car([two.cid, a.cid], [two, a]), 'bad-roots')
    const inline = CID.createV1(
      RAW_CODEC,
      identity.digest(new TextEncoder().encode('a'))
    )
    const wrapsInline = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: inline, Tsize: 1 }],
    })
    await refuses(
      car(wrapsInline.cid, [
        wrapsInline,
        { cid: inline, bytes: new TextEncoder().encode('a') },
      ]),
      'bad-hash'
    )
    const link = await pbBlock({
      Data: new UnixFS({
        type: 'symlink',
        data: new TextEncoder().encode('/etc'),
      }).marshal(),
      Links: [],
    })
    const wrapsLink = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: link.cid, Tsize: 1 }],
    })
    await refuses(car(wrapsLink.cid, [wrapsLink, link]), 'not-unixfs')
  })

  test('unpacks directories alone, a CAR with no leaf at all', async () => {
    const { plan, bytes } = await packed({ d: null, 'd/e': null })
    assert.equal(plan.layout.leaves.length, 0)
    const sink = memorySink()
    assert.deepEqual(await unpackInnerCar([bytes], sink), {
      name: 'd',
      kind: 'directory',
      files: 0,
      dirs: 2,
      bytes: 0,
    })
    assert.deepEqual(sink.dirs, ['d', 'd/e'])
  })

  test('unpacks an empty file, whose one leaf is empty', async () => {
    const { bytes } = await packed({ d: null, 'd/e': null, 'd/z': '' })
    const sink = memorySink()
    const result = await unpackInnerCar([bytes], sink)
    assert.deepEqual(result, {
      name: 'd',
      kind: 'directory',
      files: 1,
      dirs: 2,
      bytes: 0,
    })
    assert.equal(text(sink.files.get('d/z')), '')
  })
  test('refuses a CARv2, whose blocks end before its stream does, before the sink sees anything', async () => {
    const { bytes } = await packed({ d: null, 'd/a': 'alpha' })
    const pragma = Uint8Array.from([
      0x0a,
      0xa1,
      0x67,
      ...new TextEncoder().encode('version'),
      0x02,
    ])
    const header = new Uint8Array(40)
    const view = new DataView(header.buffer)
    view.setBigUint64(16, BigInt(pragma.length + header.length), true)
    view.setBigUint64(24, BigInt(bytes.length), true)
    const v2 = concat([pragma, header, bytes, filled(100, 3)])
    let begun = false
    await assert.rejects(
      unpackInnerCar([v2], {
        begin: () => {
          begun = true
        },
        write: () => undefined,
      }),
      { code: 'bad-version' }
    )
    assert.equal(begun, false)
  })

  test('keeps the sink error when closing the source fails too', async () => {
    const { bytes } = await packed({ d: null, 'd/a': 'alpha' })
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < bytes.length; i += 16)
          yield await Promise.resolve(bytes.slice(i, i + 16))
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: a source whose cleanup fails is the case under test
        throw new Error('cleanup failed')
      }
    }
    const full = Object.assign(new Error('no space'), { code: 'ENOSPC' })
    await assert.rejects(
      unpackInnerCar(source(), {
        begin: () => {
          throw full
        },
        write: () => undefined,
      }),
      (error: unknown) => error === full
    )
  })

  test('releases a stream source when the sink fails, so the caller can cancel it', async () => {
    // Random bytes, so the three 1 MiB leaves don't deduplicate into one.
    const { bytes } = await packed({
      d: null,
      'd/a': new Uint8Array(randomBytes(3 * MiB)),
    })
    let pulled = 0
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close()
        controller.enqueue(bytes.slice(pulled, pulled + 64 * 1024))
        pulled += 64 * 1024
      },
      cancel() {
        cancelled = true
      },
    })
    const full = Object.assign(new Error('no space'), { code: 'ENOSPC' })
    await assert.rejects(
      unpackInnerCar(source, {
        begin: () => {
          throw full
        },
        write: () => undefined,
      }),
      (error: unknown) => error === full
    )
    assert.equal(source.locked, false)
    await source.cancel()
    assert.equal(cancelled, true)
    assert.ok(pulled < bytes.length)
  })
})

describe('pass 2 checks every place a leaf is used', () => {
  test('refuse a repeated chunk that changed in one of its places, or a file that grew', async () => {
    const tree: MemoryTree = { d: null, 'd/a.txt': 'first', 'd/b.txt': 'first' }
    const input = memoryInput(tree)
    const plan = await planInnerCar(input.input, input.source)
    assert.equal(plan.layout.leaves.length, 1)
    tree['d/b.txt'] = 'other'
    await assert.rejects(collect(emitInnerCar(plan, input.source)), {
      code: 'changed',
      message: /entry #2/,
    })

    const grown: MemoryTree = { f: 'abc' }
    const one = memoryInput(grown)
    const planned = await planInnerCar(one.input, one.source)
    grown.f = 'abcd'
    await assert.rejects(collect(emitInnerCar(planned, one.source)), {
      code: 'changed',
    })
  })

  // A page has SharedArrayBuffer only when cross-origin isolated.
  test('pack the same CAR from views over a SharedArrayBuffer, which WebCrypto refuses', {
    skip: typeof SharedArrayBuffer === 'undefined',
  }, async () => {
    const tree: MemoryTree = { d: null, 'd/a': 'alpha', 'd/b': 'beta' }
    const { bytes } = await packed(tree)
    const { input, source } = memoryInput(tree)
    const shared = (bytes: Uint8Array): Uint8Array => {
      const view = new Uint8Array(new SharedArrayBuffer(bytes.length))
      view.set(bytes)
      return view
    }
    const sharing = {
      async *stream(path: string, options: StreamOptions) {
        for await (const chunk of source.stream(path, options))
          yield shared(chunk)
      },
      async read(path: string, offset: number, length: number) {
        return shared(await source.read(path, offset, length))
      },
    }
    const plan = await planInnerCar(input, sharing)
    assert.deepEqual(await collect(emitInnerCar(plan, sharing)), bytes)
  })

  test('unpack a CAR whose source reuses one buffer for every chunk', async () => {
    const big = 'x'.repeat(3000)
    const { bytes } = await packed({ d: null, 'd/a': 'alpha', 'd/b': big })
    // 3 bytes splits every varint and CID. 512 bytes holds a whole CID in one chunk but not its block.
    for (const size of [3, 512]) {
      const scratch = new Uint8Array(size)
      function* reusing() {
        for (let pos = 0; pos < bytes.length; pos += size) {
          const part = bytes.subarray(pos, pos + size)
          scratch.set(part)
          yield scratch.subarray(0, part.length)
        }
      }
      const sink = memorySink()
      await unpackInnerCar(reusing(), sink)
      assert.equal(text(sink.files.get('d/a')), 'alpha')
      assert.equal(text(sink.files.get('d/b')), big)
    }
  })

  test('refuse a CAR header with a key the profile never writes, as openArchive does', async () => {
    const { bytes } = await packed({ f: 'abc' })
    const [length, size] = readVarint(bytes, 0) ?? [0, 0]
    const header = cborDecode(bytes.subarray(size, size + length)) as {
      roots: CID[]
    }
    const body = cborEncode({ extra: 1, roots: header.roots, version: 1 })
    await refuses(
      concat([encodeVarint(body.length), body, bytes.subarray(size + length)]),
      'not-metadata-first'
    )
  })

  test('keep a leaf stable when the source reuses one buffer for every read', async () => {
    // A Uint8Array, and in Node a Buffer, whose `slice` is a view rather than a copy.
    const scratches = [new Uint8Array(1024)]
    if (typeof globalThis.Buffer === 'function')
      scratches.push(globalThis.Buffer.alloc(1024))
    for (const scratch of scratches) {
      const tree: MemoryTree = { d: null, 'd/a': 'first', 'd/b': 'first' }
      const { input, source } = memoryInput(tree)
      const reusing = {
        stream: source.stream,
        async read(path: string, offset: number, length: number) {
          const bytes = await source.read(path, offset, length)
          scratch.set(bytes)
          return scratch.subarray(0, bytes.length)
        },
      }
      const plan = await planInnerCar(input, reusing)
      const sink = memorySink()
      await unpackInnerCar(emitInnerCar(plan, reusing), sink)
      assert.equal(text(sink.files.get('d/b')), 'first')
      tree['d/b'] = 'other'
      await assert.rejects(collect(emitInnerCar(plan, reusing)), {
        code: 'changed',
      })
    }
  })

  test('plan the same tree when pass 1 streams every chunk through one reused buffer', async () => {
    const big = filled(2 * MiB + 5, 3)
    const tree: MemoryTree = { d: null, 'd/big.bin': big, 'd/small': 'abcd' }
    const { input, source } = memoryInput(tree)
    const expected = await planInnerCar(input, source)
    const reusing = {
      ...source,
      // Like a file stream that reads into one buffer of its own.
      async *stream(path: string, options: StreamOptions) {
        const scratch = new Uint8Array(64 * 1024)
        for await (const chunk of source.stream(path, options)) {
          for (let i = 0; i < chunk.length; i += scratch.length) {
            const part = chunk.subarray(i, i + scratch.length)
            scratch.set(part)
            yield scratch.subarray(0, part.length)
          }
        }
      },
    }
    const plan = await planInnerCar(input, reusing)
    assert.equal(plan.root.toString(), expected.root.toString())
    await collect(emitInnerCar(plan, source))
  })

  test("read every place once in pass 2, then check every file's end", async () => {
    const tree: MemoryTree = { d: null, 'd/sub': null, 'd/empty': '' }
    for (let i = 0; i < 20; i++) tree[`d/sub/${i}`] = `file ${i}`
    tree['d/twice'] = 'file 3'
    const { input, source } = memoryInput(tree)
    const plan = await planInnerCar(input, source)
    // The importer writes an empty block for each directory it is given, which the tree doesn't use.
    assert.equal(plan.nodes.size, plan.layout.metadata.length)
    let reads = 0
    const counting = {
      ...source,
      read(path: string, offset: number, length: number) {
        reads++
        return source.read(path, offset, length)
      },
    }
    await collect(emitInnerCar(plan, counting))
    // Every place of every leaf, then one end check per file once every leaf is read.
    const places = plan.layout.leaves.reduce((n, l) => n + l.targets.length, 0)
    assert.equal(reads, places + plan.layout.files.size)
    tree['d/sub/7'] = 'file 7 grew'
    await assert.rejects(collect(emitInnerCar(plan, counting)), {
      code: 'changed',
    })
    tree['d/sub/7'] = 'file 7'
    tree['d/twice'] = 'file 3 grew'
    await assert.rejects(collect(emitInnerCar(plan, counting)), {
      code: 'changed',
    })
  })

  test('refuse a file that grows while pass 2 reads another file', async () => {
    const tree: MemoryTree = { d: null, 'd/a': 'alpha', 'd/b': 'bravo' }
    const { input, source } = memoryInput(tree)
    const plan = await planInnerCar(input, source)
    const growing = {
      ...source,
      read(path: string, offset: number, length: number) {
        // a is read in full first: it grows only once pass 2 is past it.
        if (path === 'b') tree['d/a'] = 'alpha and more'
        return source.read(path, offset, length)
      },
    }
    await assert.rejects(collect(emitInnerCar(plan, growing)), {
      code: 'changed',
    })
  })

  test('refuse a file that grows after pass 2 read its repeated last leaf', async () => {
    // Leaves A, B, A: the layout reads both places of A, the last one at the file's end, before B.
    const a = filled(MiB, 1)
    const tree: MemoryTree = {
      d: null,
      'd/f': concat([a, filled(MiB, 2), a]),
    }
    const { input, source } = memoryInput(tree)
    const plan = await planInnerCar(input, source)
    const growing = {
      ...source,
      read(path: string, offset: number, length: number) {
        // While B is read, the file grows by a byte.
        if (offset === MiB)
          tree['d/f'] = concat([a, filled(MiB, 2), a, new Uint8Array(1)])
        return source.read(path, offset, length)
      },
    }
    await assert.rejects(collect(emitInnerCar(plan, growing)), {
      code: 'changed',
    })
  })

  test("refuse a tree whose metadata a default reader wouldn't hold", async () => {
    const { input, source } = memoryInput({ d: null, 'd/a': 'alpha' })
    await planInnerCar(input, source)
    await assert.rejects(
      planInnerCar(input, source, { maxMetadataBytes: 100 }),
      { code: 'too-large' }
    )
  })

  test('keep a directory listed after its own child', async () => {
    const { source } = memoryInput({ r: null })
    const plan = await planInnerCar(
      {
        type: 'directory',
        name: 'r',
        entries: [
          { type: 'directory', path: 'a/b' },
          { type: 'directory', path: 'a' },
        ],
      },
      source
    )
    assert.deepEqual(plan.layout.dirs, ['r', 'r/a', 'r/a/b'])
  })
})

describe('reader limits', () => {
  /** The dag-pb nodes and the leaves of a packed tree, in CAR order. */
  async function parts(tree: MemoryTree) {
    const { plan, blocks, bytes } = await packed(tree)
    const get = (cid: CID): Block => blocks.get(cid.toString()) as Block
    return {
      plan,
      bytes,
      nodes: plan.layout.metadata.map(({ cid }) => get(cid)),
      leaves: plan.layout.leaves.map(({ cid }) => get(cid)),
    }
  }

  test('refuse a dag-pb node twice, or one the tree does not use', async () => {
    const { plan, nodes, leaves } = await parts({ d: null, 'd/a': 'alpha' })
    const unused = await pbBlock({ Data: dirData, Links: [] })
    await refuses(car(plan.root, [...nodes, unused, ...leaves]), 'bad-tree')
    const first = nodes[0] as Block
    await refuses(car(plan.root, [...nodes, first, ...leaves]), 'bad-tree')
  })

  test('count the header and whole sections against the metadata budget', async () => {
    const { plan, bytes } = await parts({ d: null, 'd/a': 'alpha' })
    const last = plan.layout.metadata.at(-1)
    assert.ok(last != null)
    const prefix = last.offset + last.len
    await unpackInnerCar([bytes], memorySink(), { maxMetadataBytes: prefix })
    await assert.rejects(
      unpackInnerCar([bytes], memorySink(), { maxMetadataBytes: prefix - 1 }),
      { code: 'layout-limit' }
    )
  })

  test("check a section's declared length before reading its body", async () => {
    const { plan, nodes, leaves } = await parts({ d: null, 'd/a': 'alpha' })
    // A dag-pb section that claims more than the default budget, with 10 bytes of body.
    const node = nodes[0] as Block
    const claim = encodeVarint(DEFAULT_MAX_METADATA_BYTES + 1)
    await refuses(
      concat([carHeader(plan.root), claim, node.cid.bytes, new Uint8Array(10)]),
      'layout-limit'
    )
    // A leaf section longer than its file node says, cut short: refused for its length, not as cut.
    const leaf = leaves[0] as Block
    const metadata = car(plan.root, nodes)
    await refuses(
      concat([
        metadata,
        encodeVarint(leaf.cid.bytes.length + 1000),
        leaf.cid.bytes,
        leaf.bytes,
      ]),
      'bad-tree'
    )
  })

  /** A chain of `depth` single-link file nodes over a 1-byte leaf, under a wrapper. */
  async function fileChain(depth: number): Promise<Uint8Array> {
    const leaf = await rawBlock(new Uint8Array([7]))
    const chain: Block[] = []
    let child = leaf
    for (let i = 0; i < depth; i++) {
      child = await pbBlock({
        Data: new UnixFS({ type: 'file', blockSizes: [1n] }).marshal(),
        Links: [{ Hash: child.cid, Tsize: 1 }],
      })
      chain.unshift(child)
    }
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: child.cid, Tsize: 1 }],
    })
    return car(wrapper.cid, [wrapper, ...chain, leaf])
  }

  test('refuse file nodes or directories nested past MAX_DEPTH, without overflowing the stack', async () => {
    const sink = memorySink()
    await unpackInnerCar([await fileChain(MAX_DEPTH - 2)], sink)
    assert.deepEqual([...(sink.files.get('x') ?? [])], [7])
    // 5,000 levels overflow the stack of a walk with no depth limit.
    await refuses(await fileChain(5000), 'layout-limit')

    let dir = await pbBlock({ Data: dirData, Links: [] })
    const dirs = [dir]
    for (let i = 0; i < MAX_DEPTH + 100; i++) {
      dir = await pbBlock({
        Data: dirData,
        Links: [{ Name: 'a', Hash: dir.cid, Tsize: 0 }],
      })
      dirs.unshift(dir)
    }
    await refuses(car(dir.cid, dirs), 'layout-limit')
  })

  test('refuse a CAR header that is not a map, or longer than the profile writes, as the archive does', async () => {
    // A 1-byte header holding CBOR null, then one holding the number 1.
    await refuses(new Uint8Array([1, 0xf6]), 'not-metadata-first')
    await refuses(new Uint8Array([1, 0x01]), 'not-metadata-first')
    // A CBOR byte string, which decodes to a Uint8Array.
    await refuses(new Uint8Array([2, 0x41, 0]), 'not-metadata-first')
    // A 1,000-byte header is refused before its body is read or decoded.
    await refuses(
      concat([encodeVarint(1000), new Uint8Array(10)]),
      'not-metadata-first'
    )
  })

  test('read a Uint8Array as one chunk', async () => {
    const { bytes } = await parts({ d: null, 'd/a': 'alpha' })
    const sink = memorySink()
    await unpackInnerCar(bytes, sink)
    assert.equal(text(sink.files.get('d/a')), 'alpha')
  })
})

describe('round 2 reader checks', () => {
  test('refuse a small CAR that restores more than maxOutputBytes, before the sink sees anything', async () => {
    const leaf = await rawBlock(new Uint8Array(randomBytes(1024)))
    const file = await pbBlock({
      Data: new UnixFS({
        type: 'file',
        blockSizes: Array.from({ length: 100 }, () => 1024n),
      }).marshal(),
      Links: Array.from({ length: 100 }, () => ({
        Hash: leaf.cid,
        Tsize: 1024,
      })),
    })
    const dir = await pbBlock({
      Data: dirData,
      Links: Array.from({ length: 10 }, (_, i) => ({
        Name: `f${i}`,
        Hash: file.cid,
        Tsize: 102_400,
      })),
    })
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'd', Hash: dir.cid, Tsize: 1_024_000 }],
    })
    // About 6 KB of CAR that restores 1,024,000 bytes.
    const bytes = car(wrapper.cid, [wrapper, dir, file, leaf])
    let begun = false
    await assert.rejects(
      unpackInnerCar(
        [bytes],
        {
          begin: () => {
            begun = true
          },
          write: () => undefined,
        },
        { maxOutputBytes: 1_000_000 }
      ),
      { code: 'layout-limit' }
    )
    assert.equal(begun, false)
    const sink = memorySink()
    await unpackInnerCar([bytes], sink, { maxOutputBytes: 1_024_000 })
    assert.equal(sink.files.size, 10)
  })

  test('refuse dag-pb nodes in another order than the layout, as openArchive does', async () => {
    const { plan, blocks } = await packed({ d: null, 'd/a': null, 'd/b': 'b' })
    const get = (cid: CID): Block => blocks.get(cid.toString()) as Block
    const nodes = plan.layout.metadata.map(({ cid }) => get(cid))
    const leaves = plan.layout.leaves.map(({ cid }) => get(cid))
    assert.ok(nodes.length >= 3)
    const swapped = [nodes[0], nodes[2], nodes[1], ...nodes.slice(3)] as Block[]
    await refuses(car(plan.root, [...swapped, ...leaves]), 'not-metadata-first')
  })

  test('refuse a CIDv0 node, a leaf CID with a long digest, and a varint not in its shortest form', async () => {
    const empty = { Data: dirData, Links: [] }
    const bytes = dagPb.encode(empty)
    const v0 = CID.createV0(await sha256.digest(bytes))
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'd', Hash: v0, Tsize: 0 }],
    })
    await refuses(car(wrapper.cid, [wrapper, { cid: v0, bytes }]), 'not-unixfs')
    const long = CID.createV1(RAW_CODEC, createDigest(0x12, new Uint8Array(64)))
    const holder = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: long, Tsize: 1 }],
    })
    await refuses(car(holder.cid, [holder]), 'bad-hash')
    assert.throws(() => readVarint(new Uint8Array([0x81, 0x00]), 0), {
      code: 'truncated',
    })
    assert.deepEqual(readVarint(new Uint8Array([0x81, 0x01]), 0), [129, 2])
  })

  test("refuse a file node whose children don't hold the sizes it records, or whose filesize is off", async () => {
    const one = await rawBlock(new Uint8Array([1]))
    const three = await rawBlock(new Uint8Array([3, 3, 3]))
    const child = async (leaf: Block, size: bigint): Promise<Block> =>
      pbBlock({
        Data: new UnixFS({ type: 'file', blockSizes: [size] }).marshal(),
        Links: [{ Hash: leaf.cid, Tsize: Number(size) }],
      })
    const c1 = await child(one, 1n)
    const c3 = await child(three, 3n)
    // 2 + 2 adds up to 1 + 3, but neither child holds 2 bytes.
    const parent = await pbBlock({
      Data: new UnixFS({ type: 'file', blockSizes: [2n, 2n] }).marshal(),
      Links: [
        { Hash: c1.cid, Tsize: 1 },
        { Hash: c3.cid, Tsize: 3 },
      ],
    })
    const wrap = async (file: Block): Promise<Block> =>
      pbBlock({
        Data: dirData,
        Links: [{ Name: 'x', Hash: file.cid, Tsize: 4 }],
      })
    const w1 = await wrap(parent)
    await refuses(car(w1.cid, [w1, parent, c1, c3, one, three]), 'bad-tree')

    // A second filesize field (3), 9, after the right one: the wire value is read, not recomputed.
    const data = concat([
      new UnixFS({ type: 'file', blockSizes: [1n] }).marshal(),
      new Uint8Array([0x18, 9]),
    ])
    const lying = await pbBlock({
      Data: data,
      Links: [{ Hash: one.cid, Tsize: 1 }],
    })
    const w2 = await wrap(lying)
    await refuses(car(w2.cid, [w2, lying, one]), 'bad-tree')
  })

  test('refuse a shard that links a raw block as a sub-shard', async () => {
    const leaf = await rawBlock(new Uint8Array([1]))
    const shard = await pbBlock({
      Data: new UnixFS({
        type: 'hamt-sharded-directory',
        fanout: 256n,
        hashType: 0x22n,
      }).marshal(),
      Links: [{ Name: '00', Hash: leaf.cid, Tsize: 1 }],
    })
    const wrapper = await pbBlock({
      Data: dirData,
      Links: [{ Name: 'x', Hash: shard.cid, Tsize: 1 }],
    })
    await refuses(car(wrapper.cid, [wrapper, shard, leaf]), 'not-unixfs')
  })

  test('pack and unpack a folder big enough for the importer to shard it', async () => {
    const tree: MemoryTree = { big: null }
    // Long names push the directory past the profile's shard threshold.
    const name = (i: number): string => `big/file-${i}-${'x'.repeat(100)}.txt`
    for (let i = 0; i < 2500; i++) tree[name(i)] = `${i}`
    const { plan, bytes } = await packed(tree)
    const sharded = [...plan.nodes.values()].some(
      (node) =>
        UnixFS.unmarshal(dagPb.decode(node.bytes).Data ?? new Uint8Array())
          .type === 'hamt-sharded-directory'
    )
    assert.ok(sharded, 'the importer did not shard the folder')
    const sink = memorySink()
    await unpackInnerCar([bytes], sink)
    assert.equal(sink.files.size, 2500)
    assert.equal(text(sink.files.get(name(1234))), '1234')
  })

  test('refuse an input that would restore more than maxOutputBytes, on write', async () => {
    const { input, source } = memoryInput({ d: null, 'd/a': 'alpha' })
    await assert.rejects(planInnerCar(input, source, { maxOutputBytes: 4 }), {
      code: 'too-large',
    })
  })

  test('refuse a file that grew or shrank between the walk and pass 1, as filecoin-pin does', async () => {
    // The walk says 4 bytes, but pass 1 reads 5, or 1.
    for (const content of ['abcde', 'x']) {
      const { source } = memoryInput({ f: content })
      await assert.rejects(
        planInnerCar({ type: 'file', name: 'f', size: 4 }, source, {
          maxOutputBytes: 4,
        }),
        { code: 'changed' }
      )
    }
  })

  test('refuse a root that is not dag-pb', () => {
    assert.throws(
      () =>
        layout(
          CID.createV1(RAW_CODEC, createDigest(0x12, new Uint8Array(32))),
          new Map()
        ),
      { code: 'not-unixfs' }
    )
  })
})

describe('isUnsafeName', () => {
  test('refuses names that escape or alias a path, and the Windows ones only when asked', () => {
    // A leading U+FEFF: dag-pb's decoder drops it, so the name read back is another one.
    // An unpaired surrogate: dag-pb's encoder writes U+FFFD in its place.
    for (const name of [
      '',
      '.',
      '..',
      'a/b',
      'a\\b',
      'a\0b',
      '\uFEFFa',
      'a\uD800',
      '\uDC00b',
    ])
      assert.equal(isUnsafeName(name), true, name)
    assert.equal(isUnsafeName('a\uFEFF'), false)
    for (const name of [
      'CON',
      'nul.txt',
      'COM0',
      'lpt0.log',
      'COM¹.txt',
      'com²',
      'LPT³.tar.gz',
      'a:b',
      'trailing.',
      'trailing ',
      ' leading',
    ]) {
      assert.equal(isUnsafeName(name), false, name)
      assert.equal(isUnsafeName(name, { windows: true }), true, name)
    }
    assert.equal(isUnsafeName('.hidden'), false)
    for (const name of ['COM10', 'LPT⁴', 'console', 'nul-1'])
      assert.equal(isUnsafeName(name, { windows: true }), false, name)
  })
})

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CarBlockIterator } from '@ipld/car'
import * as DagPb from '@ipld/dag-pb'
import { CliError } from 'clipact'
import { UnixFS } from 'ipfs-unixfs'
import { varint } from 'multiformats'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import * as Digest from 'multiformats/hashes/digest'
import { sha256 } from 'multiformats/hashes/sha2'
import { DFS_CAR_ACCEPT, downloadDag, readCar } from '../src/storage/dag.ts'
import { type Block, carFetch, carStream, dfsBlocks } from './dfs-car.ts'
import { packDirectory, packFile, tempDir } from './helpers.ts'

const SP_URL = 'https://sp.example/ipfs/root'

/** Create a small site with nested assets, a multi-chunk file and an empty dir. */
async function site(root: string): Promise<string> {
  const dir = join(root, 'site')
  await mkdir(join(dir, 'assets', 'img'), { recursive: true })
  await mkdir(join(dir, 'empty'))
  await writeFile(join(dir, 'index.html'), '<h1>hello</h1>')
  await writeFile(join(dir, 'assets', 'img', 'big.bin'), randomBytes(2_500_000))
  // Repeated chunks: the CAR stream sends each one every time it is linked.
  await writeFile(join(dir, 'zeros.bin'), Buffer.alloc(3 * 1024 * 1024 + 7))
  return dir
}

/** Pack `dir` and return a fetch serving its blocks depth-first. */
async function served(root: string, dir: string) {
  const car = join(root, 'site.car')
  const { rootCid } = await packDirectory(dir, car)
  return {
    car,
    rootCid,
    fetch: carFetch(() => carStream(rootCid, dfsBlocks(car))),
  }
}

/** Blocks of a CAR in its stored order. */
async function storedBlocks(car: string): Promise<Block[]> {
  const blocks: Block[] = []
  const iterator = await CarBlockIterator.fromIterable(createReadStream(car))
  for await (const block of iterator) {
    blocks.push({ cid: CID.decode(block.cid.bytes), bytes: block.bytes })
  }
  return blocks
}

/**
 * Assert `promise` rejects with a CliError of `code`, and a message that
 * matches `pattern` when given.
 */
async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  pattern?: RegExp
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CliError, String(error))
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    return true
  })
}

test('downloadDag extracts a folder from a depth-first CAR stream', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { rootCid, fetch } = await served(root, dir)
  const output = join(root, 'out')
  const result = await downloadDag({
    url: SP_URL,
    rootCid: rootCid.toString(),
    output,
    fetch,
  })
  assert.equal(result.kind, 'folder')
  assert.equal(result.files, 3)
  assert.equal(result.url, SP_URL)
  assert.equal(result.size, await treeSize(dir))
  assert.deepEqual(fetch.accepts, [DFS_CAR_ACCEPT])
  for (const path of ['index.html', 'assets/img/big.bin', 'zeros.bin']) {
    assert.deepEqual(
      await readFile(join(output, path)),
      await readFile(join(dir, path)),
      path
    )
  }
  assert.deepEqual(await readdir(join(output, 'empty')), [])
  await assert.rejects(stat(`${output}.filecoin-partial`))
})

test('downloadDag extracts a single file, raw or chunked', async () => {
  const root = await tempDir()
  for (const [name, size] of [
    ['small.txt', 100],
    ['large.bin', 2_200_000],
  ] as const) {
    const source = join(root, name)
    await writeFile(source, randomBytes(size))
    const car = join(root, `${name}.car`)
    const { rootCid } = await packFile(source, car)
    const output = join(root, `out-${name}`)
    const result = await downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output,
      fetch: carFetch(() => carStream(rootCid, dfsBlocks(car))),
    })
    assert.equal(result.kind, 'file')
    assert.equal(result.files, 1)
    assert.deepEqual(await readFile(output), await readFile(source))
  }
})

test('downloadDag extracts a HAMT-sharded directory', async () => {
  const root = await tempDir()
  const dir = join(root, 'many')
  await mkdir(dir)
  // Past the importer's 256 KiB shard threshold for directory links.
  const count = 5000
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `a-longer-file-name-${i}.txt`), `content ${i}`)
  }
  const car = join(root, 'many.car')
  const { rootCid } = await packDirectory(dir, car)
  const [first] = await storedBlocks(car)
  assert.ok(first?.cid.equals(rootCid))
  const unixfs = UnixFS.unmarshal(
    DagPb.decode(first.bytes).Data ?? new Uint8Array()
  )
  assert.equal(unixfs.type, 'hamt-sharded-directory')

  const output = join(root, 'out')
  const result = await downloadDag({
    url: SP_URL,
    rootCid: rootCid.toString(),
    output,
    fetch: carFetch(() => carStream(rootCid, dfsBlocks(car))),
  })
  assert.equal(result.files, count)
  assert.equal((await readdir(output)).length, count)
  assert.equal(
    await readFile(join(output, 'a-longer-file-name-1234.txt'), 'utf8'),
    'content 1234'
  )
})

test('downloadDag rejects a CAR in another order, such as leaves first', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  const blocks = (await storedBlocks(car)).reverse()
  const output = join(root, 'out')
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output,
      fetch: carFetch(() => carStream(rootCid, blocks)),
    }),
    'verification_failed'
  )
  await assert.rejects(stat(output))
  await assert.rejects(stat(`${output}.filecoin-partial`))
})

test('downloadDag rejects a block whose bytes do not match its CID', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  async function* tampered() {
    let i = 0
    for await (const block of dfsBlocks(car)) {
      if (i++ === 3) {
        const bytes = new Uint8Array(block.bytes)
        bytes[0] = (bytes[0] ?? 0) ^ 0xff
        yield { cid: block.cid, bytes }
      } else {
        yield block
      }
    }
  }
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(rootCid, tampered())),
    }),
    'verification_failed'
  )
})

test('downloadDag rejects a truncated stream and another root', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  async function* truncated() {
    let i = 0
    for await (const block of dfsBlocks(car)) {
      if (i++ === 5) return
      yield block
    }
  }
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(rootCid, truncated())),
    }),
    'verification_failed'
  )
  const other = CID.create(
    1,
    Raw.code,
    await sha256.digest(new Uint8Array([1]))
  )
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: other.toString(),
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(rootCid, dfsBlocks(car))),
    }),
    'verification_failed'
  )
})

test('downloadDag refuses entry names that leave the output', async () => {
  const root = await tempDir()
  const leaf = new TextEncoder().encode('owned')
  const leafCid = CID.create(1, Raw.code, await sha256.digest(leaf))
  const dirBytes = DagPb.encode(
    DagPb.prepare({
      Data: new UnixFS({ type: 'directory' }).marshal(),
      Links: [{ Hash: leafCid, Name: '..', Tsize: leaf.length }],
    })
  )
  const dirCid = CID.create(1, DagPb.code, await sha256.digest(dirBytes))
  const blocks = [
    { cid: dirCid, bytes: dirBytes },
    { cid: leafCid, bytes: leaf },
  ]
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: dirCid.toString(),
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(dirCid, blocks)),
    }),
    'unsafe_path'
  )
})

test('downloadDag maps a 404 and checks the response type', async () => {
  const root = await tempDir()
  const notIndexed = new CliError({ code: 'not_found', message: 'later' })
  await assert.rejects(
    downloadDag({
      url: SP_URL,
      rootCid: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
      output: join(root, 'out'),
      notFound: () => notIndexed,
      fetch: carFetch(
        () =>
          carStream(
            CID.parse(
              'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
            ),
            []
          ),
        {
          status: 404,
        }
      ),
    }),
    (error) => error === notIndexed
  )
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(rootCid, dfsBlocks(car)), {
        contentType: 'application/vnd.ipld.car;version=1;order=unk;dups=y',
      }),
    }),
    'verification_failed'
  )
})

test('downloadDag never replaces a directory, and a file only with overwrite', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  const fetch = carFetch(() => carStream(rootCid, dfsBlocks(car)))
  const existingDir = join(root, 'existing-dir')
  await mkdir(existingDir)
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output: existingDir,
      fetch,
      overwrite: true,
    }),
    'output_exists'
  )
  const existingFile = join(root, 'existing-file')
  await writeFile(existingFile, 'old')
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output: existingFile,
      fetch,
    }),
    'output_exists'
  )
  // A folder root never replaces a file, even with overwrite.
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output: existingFile,
      fetch,
      overwrite: true,
    }),
    'output_exists'
  )
  assert.equal(await readFile(existingFile, 'utf8'), 'old')

  const source = join(root, 'note.txt')
  await writeFile(source, 'new')
  const fileCar = join(root, 'note.car')
  const packed = await packFile(source, fileCar)
  await downloadDag({
    url: SP_URL,
    rootCid: packed.rootCid.toString(),
    output: existingFile,
    overwrite: true,
    fetch: carFetch(() => carStream(packed.rootCid, dfsBlocks(fileCar))),
  })
  assert.equal(await readFile(existingFile, 'utf8'), 'new')
})

test('downloadDag accepts a CIDv1 answer to a CIDv0 root', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid, fetch } = await served(root, dir)
  const result = await downloadDag({
    url: SP_URL,
    rootCid: rootCid.toV0().toString(),
    output: join(root, 'out'),
    fetch,
  })
  assert.equal(result.kind, 'folder')
  assert.equal(result.files, 3)
  assert.ok(car)
})

/**
 * A folder full of repeats: two identical multi-chunk files, a file whose
 * 1 MiB chunks repeat, a small file identical to another, and a
 * subdirectory duplicated under another name.
 */
async function repeats(root: string): Promise<string> {
  const dir = join(root, 'repeats')
  const big = randomBytes(2_500_000)
  await mkdir(join(dir, 'sub', 'deep'), { recursive: true })
  await writeFile(join(dir, 'a.bin'), big)
  await writeFile(join(dir, 'b.bin'), big)
  await writeFile(join(dir, 'zeros.bin'), Buffer.alloc(4 * 1024 * 1024 + 5))
  await writeFile(join(dir, 'note.txt'), 'same')
  await writeFile(join(dir, 'sub', 'note.txt'), 'same')
  await writeFile(join(dir, 'sub', 'deep', 'c.bin'), randomBytes(1_200_000))
  await writeFile(join(dir, 'sub', 'deep', 'd.bin'), big)
  await mkdir(join(dir, 'copy', 'deep'), { recursive: true })
  for (const path of ['note.txt', 'deep/c.bin', 'deep/d.bin']) {
    await writeFile(
      join(dir, 'copy', path),
      await readFile(join(dir, 'sub', path))
    )
  }
  return dir
}

/** Relative paths of every file under `dir`, sorted. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort()
}

/** Total bytes of the files under `dir`. */
async function treeSize(dir: string): Promise<number> {
  let total = 0
  for (const path of await files(dir))
    total += (await stat(join(dir, path))).size
  return total
}

test('downloadDag rebuilds repeats a dups=n CAR sends once', async () => {
  const root = await tempDir()
  const dir = await repeats(root)
  const car = join(root, 'repeats.car')
  const { rootCid } = await packDirectory(dir, car)
  let once = 0
  for await (const _ of dfsBlocks(car, { dups: false })) once++
  let all = 0
  for await (const _ of dfsBlocks(car)) all++
  assert.ok(once < all, `dups=n sends ${once} of ${all} blocks`)

  for (const contentType of [
    'application/vnd.ipld.car;version=1;order=dfs;dups=n',
    'application/vnd.ipld.car',
  ]) {
    const output = join(root, `out-${once}-${contentType.length}`)
    const result = await downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output,
      fetch: carFetch(
        () => carStream(rootCid, dfsBlocks(car, { dups: false })),
        {
          contentType,
        }
      ),
    })
    const expected = await files(dir)
    assert.equal(result.files, expected.length)
    assert.equal(result.size, await treeSize(dir), 'repeats count once each')
    assert.deepEqual(await files(output), expected)
    for (const path of expected) {
      assert.deepEqual(
        await readFile(join(output, path)),
        await readFile(join(dir, path)),
        path
      )
    }
    assert.deepEqual(await readdir(join(output, 'copy', 'deep')), [
      'c.bin',
      'd.bin',
    ])
  }
})

test('downloadDag reads a dups=y CAR of repeats without rebuilding', async () => {
  const root = await tempDir()
  const dir = await repeats(root)
  const car = join(root, 'repeats.car')
  const { rootCid } = await packDirectory(dir, car)
  const output = join(root, 'out')
  const result = await downloadDag({
    url: SP_URL,
    rootCid: rootCid.toString(),
    output,
    fetch: carFetch(() => carStream(rootCid, dfsBlocks(car))),
  })
  assert.equal(result.files, (await files(dir)).length)
  assert.equal(result.size, await treeSize(dir))
  assert.deepEqual(
    await readFile(join(output, 'zeros.bin')),
    await readFile(join(dir, 'zeros.bin'))
  )
})

test('downloadDag rejects a CAR that declares dups=y but leaves repeats out', async () => {
  const root = await tempDir()
  const dir = await repeats(root)
  const car = join(root, 'repeats.car')
  const { rootCid } = await packDirectory(dir, car)
  const output = join(root, 'out')
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: rootCid.toString(),
      output,
      fetch: carFetch(() =>
        carStream(rootCid, dfsBlocks(car, { dups: false }))
      ),
    }),
    'verification_failed'
  )
  await assert.rejects(stat(`${output}.filecoin-partial`))
})

/** `n` as the varint that prefixes a CAR header or section. */
function length(n: number): Uint8Array {
  return varint.encodeTo(n, new Uint8Array(varint.encodingLength(n)))
}

/** Resolve once `path` exists. Fails after 5 seconds or when `signal` aborts. */
async function appears(path: string, signal: AbortSignal): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const found = await stat(path).then(
      () => true,
      () => false
    )
    if (found) return
    await delay(10, undefined, { signal })
  }
  throw new Error(`${path} never appeared.`)
}

/**
 * A `fetch` whose depth-first CAR body sends `head`, then `tail` once
 * `ready` resolves, then stalls until the request aborts. A reader that
 * waits for more bytes than these never finishes. `signals` records the
 * signal of each request.
 */
function stallingFetch(
  head: Uint8Array,
  tail?: { bytes: Uint8Array; ready: (signal: AbortSignal) => Promise<void> }
): typeof fetch & { signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const fn = (_input: RequestInfo | URL, request?: RequestInit) => {
    const signal = request?.signal ?? new AbortController().signal
    signals.push(signal)
    const chunks = [() => Promise.resolve(head)]
    if (tail) chunks.push(() => tail.ready(signal).then(() => tail.bytes))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason))
      },
      async pull(controller) {
        const next = chunks.shift()
        if (next) return controller.enqueue(await next())
        // Stall: only the abort listener above ends the stream.
        await new Promise(() => {
          // Never resolves.
        })
      },
    })
    return Promise.resolve(
      new Response(stream, {
        headers: {
          'content-type': 'application/vnd.ipld.car;version=1;order=dfs;dups=y',
        },
      })
    )
  }
  return Object.assign(fn, { signals }) as typeof fetch & {
    signals: AbortSignal[]
  }
}

/**
 * Run `downloadDag` against `fetch` and assert that it fails with
 * `verification_failed` matching `pattern`, aborts the request, and leaves
 * no output.
 */
async function refuses(
  fetch: ReturnType<typeof stallingFetch>,
  rootCid: string,
  output: string,
  pattern: RegExp
) {
  await rejectsWith(
    downloadDag({ url: SP_URL, rootCid, output, fetch }),
    'verification_failed',
    pattern
  )
  assert.equal(fetch.signals.length, 1)
  assert.ok(fetch.signals[0]?.aborted, 'the request is aborted')
  await assert.rejects(stat(output))
  await assert.rejects(stat(`${output}.filecoin-partial`))
}

const RAW_ROOT = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'

test('downloadDag refuses a CAR header over 64 KiB before reading it in full', {
  timeout: 10_000,
}, async () => {
  const root = await tempDir()
  await refuses(
    stallingFetch(Buffer.concat([length(64 * 1024 + 1), new Uint8Array(16)])),
    RAW_ROOT,
    join(root, 'out'),
    /CAR header of length 65537 exceeds maxAllowedHeaderSize of 65536/
  )
})

test('downloadDag refuses a CARv2 header before it seeks to the data', {
  timeout: 10_000,
}, async () => {
  const root = await tempDir()
  // The CARv2 pragma, then a fixed header whose data starts 4 GiB in.
  const pragma = Uint8Array.from([
    0x0a,
    0xa1,
    0x67,
    ...new TextEncoder().encode('version'),
    0x02,
  ])
  const header = new Uint8Array(40)
  new DataView(header.buffer).setBigUint64(16, 4n << 30n, true)
  await refuses(
    stallingFetch(Buffer.concat([pragma, header, new Uint8Array(1024)])),
    RAW_ROOT,
    join(root, 'out'),
    /Invalid CAR version: 2 \(expected 1\)/
  )
})

test('downloadDag refuses a section length the decoder cannot read', {
  timeout: 10_000,
}, async () => {
  const root = await tempDir()
  const cid = CID.parse(RAW_ROOT)
  const chunks: Uint8Array[] = []
  for await (const chunk of carStream(cid, [])) chunks.push(chunk)
  // 2^56, a 9-byte varint, past the 8 bytes the decoder reads ahead.
  const huge = Uint8Array.from([...new Array(8).fill(0x80), 0x01])
  await refuses(
    stallingFetch(Buffer.concat([...chunks, huge, new Uint8Array(16)])),
    RAW_ROOT,
    join(root, 'out'),
    /invalid CAR/
  )
})

test('downloadDag refuses a CAR section over 8 MiB during extraction', {
  timeout: 10_000,
}, async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  // The root, assets, img, the big.bin node, and big.bin's first chunk.
  const first: Block[] = []
  for await (const block of dfsBlocks(car)) {
    if (first.push(block) === 5) break
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of carStream(rootCid, first)) chunks.push(chunk)
  const output = join(root, 'out')
  await refuses(
    stallingFetch(Buffer.concat(chunks), {
      bytes: Buffer.concat([length(8 * 1024 * 1024 + 1), new Uint8Array(64)]),
      // Send the oversized section only once big.bin is being written.
      ready: (signal) =>
        appears(
          join(`${output}.filecoin-partial`, 'assets', 'img', 'big.bin'),
          signal
        ),
    }),
    rootCid.toString(),
    output,
    /CAR section of length 8388609 exceeds maxAllowedSectionSize of 8388608/
  )
})

test('downloadDag passes an error of the response body through', {
  timeout: 10_000,
}, async () => {
  const root = await tempDir()
  const dir = await site(root)
  const { car, rootCid } = await served(root, dir)
  const chunks: Uint8Array[] = []
  for await (const chunk of carStream(rootCid, dfsBlocks(car))) {
    chunks.push(chunk)
  }
  const all = Buffer.concat(chunks)
  const output = join(root, 'out')
  const reset = new Error('connection reset')
  let pulls = 0
  // Half the CAR, then a reset once big.bin is being written.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pulls++ === 0)
        return controller.enqueue(all.subarray(0, all.length / 2))
      await appears(
        join(`${output}.filecoin-partial`, 'assets', 'img', 'big.bin'),
        AbortSignal.timeout(5000)
      )
      controller.error(reset)
    },
  })
  const fetch = () =>
    Promise.resolve(
      new Response(body, {
        headers: {
          'content-type': 'application/vnd.ipld.car;version=1;order=dfs;dups=y',
        },
      })
    )
  await assert.rejects(
    downloadDag({ url: SP_URL, rootCid: rootCid.toString(), output, fetch }),
    (error) => error === reset
  )
  await assert.rejects(stat(output))
  await assert.rejects(stat(`${output}.filecoin-partial`))
})

/** Split `bytes` into chunks of `size` bytes, as copies. */
function* chunked(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size)
}

test('readCar returns each block in a buffer of its own, from chunks of any size', async () => {
  const big = CID.create(1, Raw.code, await sha256.digest(new Uint8Array([1])))
  const small = CID.create(
    1,
    Raw.code,
    await sha256.digest(new Uint8Array([2]))
  )
  const blocks = [
    { cid: big, bytes: randomBytes(256 * 1024) },
    { cid: small, bytes: randomBytes(100) },
    {
      cid: CID.create(1, Raw.code, await sha256.digest(new Uint8Array())),
      bytes: new Uint8Array(),
    },
  ]
  const parts: Uint8Array[] = []
  for await (const chunk of carStream(big, blocks)) parts.push(chunk)
  const bytes = Buffer.concat(parts)
  for (const size of [1, 7, 4096, bytes.length]) {
    const car = await readCar(Readable.from(chunked(bytes, size)), SP_URL)
    assert.ok(car.root?.equals(big))
    for (const expected of blocks) {
      const block = await car.next()
      assert.ok(block, `chunks of ${size}`)
      assert.ok(block.cid.equals(expected.cid), `chunks of ${size}`)
      assert.deepEqual(block.bytes, new Uint8Array(expected.bytes))
      // A view of a larger buffer would keep that buffer alive.
      assert.ok(
        block.bytes.buffer.byteLength <= Math.max(block.bytes.length, 8),
        `a ${block.bytes.length}-byte block holds a ${block.bytes.buffer.byteLength}-byte buffer`
      )
    }
    assert.equal(await car.next(), undefined)
  }
})

test('downloadDag names an unexpected CID too long to print by its size', async () => {
  const root = await tempDir()
  const cid = CID.create(
    1,
    Raw.code,
    Digest.create(sha256.code, new Uint8Array(1024 * 1024))
  )
  const blocks = [{ cid, bytes: new Uint8Array(1) }]
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: RAW_ROOT,
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(CID.parse(RAW_ROOT), blocks)),
    }),
    'verification_failed',
    /^Expected block \S+, got a 1048582-byte CID with codec 0x55\.$/
  )
})

test('downloadDag names a linked CID too long to print by its size', async () => {
  const root = await tempDir()
  const child = CID.create(
    1,
    Raw.code,
    Digest.create(sha256.code, new Uint8Array(1024 * 1024))
  )
  const dirBytes = DagPb.encode(
    DagPb.prepare({
      Data: new UnixFS({ type: 'directory' }).marshal(),
      Links: [{ Hash: child, Name: 'big', Tsize: 1 }],
    })
  )
  const dirCid = CID.create(1, DagPb.code, await sha256.digest(dirBytes))
  const blocks = [
    { cid: dirCid, bytes: dirBytes },
    { cid: child, bytes: new Uint8Array(1) },
  ]
  await rejectsWith(
    downloadDag({
      url: SP_URL,
      rootCid: dirCid.toString(),
      output: join(root, 'out'),
      fetch: carFetch(() => carStream(dirCid, blocks)),
    }),
    'verification_failed',
    /^Block a 1048582-byte CID with codec 0x55 does not match its CID\.$/
  )
})

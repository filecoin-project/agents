import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CarBlockIterator } from '@ipld/car'
import * as DagPb from '@ipld/dag-pb'
import { CliError } from 'clipact'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as Raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { DFS_CAR_ACCEPT, downloadDag } from '../src/storage/dag.ts'
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

/** Assert `promise` rejects with a CliError of `code`. */
async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CliError, String(error))
    assert.equal(error.code, code, error.message)
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

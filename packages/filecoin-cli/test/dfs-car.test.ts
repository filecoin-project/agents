import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { CarBlockIterator } from '@ipld/car'
import * as CarBufferWriter from '@ipld/car/buffer-writer'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { type FileCandidate, importer } from 'ipfs-unixfs-importer'
import { varint } from 'multiformats'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { type DfsCar, planDirectory, planFile } from '../src/storage/dfs-car.ts'
import {
  directoryCandidates,
  IMPORTER_OPTIONS,
  listEntries,
} from '../src/storage/pack.ts'
import { extractCar, tempDir, writeCar } from './helpers.ts'

/**
 * Import `source` straight into a block map, with the planner's candidates
 * and profile, as a reference: its root CID, its sorted block CIDs, and the
 * size of a CAR holding each block once.
 */
async function importReference(
  source: string,
  kind: 'file' | 'folder'
): Promise<{ rootCid: string; blocks: string[]; size: number }> {
  const path = resolve(source)
  const name = basename(path)
  let candidates: ReturnType<typeof directoryCandidates> | FileCandidate[]
  if (kind === 'folder') {
    const { files, directories } = await listEntries(path)
    candidates = directoryCandidates(path, name, files, directories)
  } else {
    candidates = [{ path: name, content: createReadStream(path) }]
  }
  const blocks = new Map<string, number>()
  const blockstore = {
    put(cid: CID, bytes: Uint8Array) {
      const length = cid.bytes.length + bytes.length
      blocks.set(cid.toString(), varint.encodingLength(length) + length)
      return cid
    },
  }
  let root: CID | undefined
  for await (const entry of importer(
    candidates,
    blockstore,
    IMPORTER_OPTIONS
  )) {
    if (entry.path === name) root = entry.cid
  }
  assert.ok(root)
  let size = CarBufferWriter.headerLength({ roots: [root] })
  for (const length of blocks.values()) size += length
  return { rootCid: root.toString(), blocks: [...blocks.keys()].sort(), size }
}

/**
 * Read a CAR and check its order: the header has one root, the first block
 * is the root, no block repeats, and every other block is linked from a
 * block before it. Returns the CIDs in order.
 */
async function assertDfs(path: string, rootCid: string): Promise<string[]> {
  const blocks = await CarBlockIterator.fromIterable(createReadStream(path))
  const roots = await blocks.getRoots()
  assert.deepEqual(
    roots.map((root) => root.toString()),
    [rootCid]
  )
  const order: string[] = []
  const linked = new Set<string>([rootCid])
  for await (const { cid, bytes } of blocks) {
    const key = cid.toString()
    assert.ok(!order.includes(key), `block ${key} is written twice`)
    assert.ok(linked.has(key), `block ${key} comes before any parent`)
    order.push(key)
    if (cid.code === dagPb.code) {
      for (const link of dagPb.decode(bytes).Links) {
        linked.add(link.Hash.toString())
      }
    }
  }
  assert.equal(order[0], rootCid)
  return order
}

/**
 * Plan, write, and check a CAR against a plain import: same root CID, same
 * blocks, the planned size, and DFS order. Then extract it with `get`.
 */
async function roundTrip(
  root: string,
  source: string,
  kind: 'file' | 'folder'
): Promise<{ car: DfsCar; bytes: Buffer; out: string }> {
  const car = await (kind === 'folder' ? planDirectory : planFile)(source)
  const reference = await importReference(source, kind)
  assert.equal(car.rootCid.toString(), reference.rootCid)
  assert.equal(car.size, reference.size)

  const path = join(root, 'dfs.car')
  const bytes = await writeCar(car, path)
  assert.equal(bytes.length, car.size)
  const order = await assertDfs(path, car.rootCid.toString())
  assert.equal(order.length, car.blocks)
  assert.deepEqual([...order].sort(), reference.blocks)

  const out = join(root, 'out')
  const extracted = await extractCar(path, car.rootCid.toString(), out)
  assert.equal(extracted.files, car.files)
  return { car, bytes, out }
}

test('a one-chunk file is a raw root written alone', async () => {
  const root = await tempDir()
  const data = randomBytes(4096)
  const path = join(root, 'note.bin')
  await writeFile(path, data)
  const { car, out } = await roundTrip(root, path, 'file')
  const expected = CID.create(1, raw.code, await sha256.digest(data))
  assert.equal(car.rootCid.toString(), expected.toString())
  assert.equal(car.blocks, 1)
  assert.ok(data.equals(await readFile(out)))
})

test('a multi-chunk file writes its file node before the leaves', async () => {
  const root = await tempDir()
  const data = randomBytes(3.5 * 1024 * 1024)
  const path = join(root, 'big.bin')
  await writeFile(path, data)
  const { car, out } = await roundTrip(root, path, 'file')
  assert.equal(car.rootCid.code, 0x70)
  assert.equal(car.blocks, 5)
  assert.ok(data.equals(await readFile(out)))
})

test('a file of repeated chunks writes each distinct leaf once', async () => {
  const root = await tempDir()
  const chunk = randomBytes(1024 * 1024)
  const path = join(root, 'repeat.bin')
  await writeFile(path, Buffer.concat([chunk, chunk, chunk, randomBytes(10)]))
  const { car, out } = await roundTrip(root, path, 'file')
  assert.equal(car.blocks, 3)
  assert.ok((await readFile(path)).equals(await readFile(out)))
})

test('nested, empty, and repeated entries pack in DFS order', async () => {
  const root = await tempDir()
  const dir = join(root, 'site')
  const big = randomBytes(2_500_000)
  await mkdir(join(dir, 'assets', 'img'), { recursive: true })
  await mkdir(join(dir, 'empty', 'deeper'), { recursive: true })
  await mkdir(join(dir, 'copy'))
  await writeFile(join(dir, 'index.html'), '<h1>hello</h1>')
  await writeFile(join(dir, 'assets', 'img', 'big.bin'), big)
  await writeFile(join(dir, 'copy', 'big.bin'), big)
  await writeFile(join(dir, 'copy', 'index.html'), '<h1>hello</h1>')
  await writeFile(join(dir, '.env'), 'SECRET=1')

  const { car, out } = await roundTrip(root, dir, 'folder')
  assert.equal(car.files, 4)
  assert.ok(big.equals(await readFile(join(out, 'copy', 'big.bin'))))
  assert.ok(big.equals(await readFile(join(out, 'assets', 'img', 'big.bin'))))
  assert.equal(
    await readFile(join(out, 'index.html'), 'utf8'),
    '<h1>hello</h1>'
  )
  assert.ok((await stat(join(out, 'empty', 'deeper'))).isDirectory())
  await assert.rejects(stat(join(out, '.env')), { code: 'ENOENT' })
})

test('repeated files and chunks are written once and extract exactly', async () => {
  const root = await tempDir()
  const dir = join(root, 'repeats')
  await mkdir(join(dir, 'copy'), { recursive: true })
  const twin = randomBytes(2_500_000)
  const chunk = randomBytes(1024 * 1024)
  const repeated = Buffer.concat([chunk, chunk, chunk, randomBytes(10)])
  await writeFile(join(dir, 'twin.bin'), twin)
  await writeFile(join(dir, 'copy', 'twin.bin'), twin)
  await writeFile(join(dir, 'repeat.bin'), repeated)

  const { out } = await roundTrip(root, dir, 'folder')
  assert.ok(twin.equals(await readFile(join(out, 'twin.bin'))))
  assert.ok(twin.equals(await readFile(join(out, 'copy', 'twin.bin'))))
  assert.ok(repeated.equals(await readFile(join(out, 'repeat.bin'))))

  // Count every block in the CAR, then check the repeated ones by CID.
  const counts = new Map<string, number>()
  const blocks = await CarBlockIterator.fromIterable(
    createReadStream(join(root, 'dfs.car'))
  )
  for await (const { cid } of blocks) {
    counts.set(cid.toString(), (counts.get(cid.toString()) ?? 0) + 1)
  }
  const chunkCid = CID.create(1, raw.code, await sha256.digest(chunk))
  const twinCid = (await planFile(join(dir, 'twin.bin'))).rootCid
  assert.equal(counts.get(chunkCid.toString()), 1)
  assert.equal(counts.get(twinCid.toString()), 1)
  for (const [cid, count] of counts) assert.equal(count, 1, cid)
})

test('an empty folder is a single directory block', async () => {
  const root = await tempDir()
  const dir = join(root, 'blank')
  await mkdir(dir)
  const { car } = await roundTrip(root, dir, 'folder')
  assert.equal(car.blocks, 1)
})

test('a folder past the shard threshold writes its HAMT before entries', async () => {
  const root = await tempDir()
  const dir = join(root, 'flat')
  await mkdir(dir)
  // About 100 bytes of directory block per entry: over 256 KiB in all.
  const pad = 'x'.repeat(48)
  await Promise.all(
    Array.from({ length: 3000 }, (_, i) =>
      writeFile(join(dir, `${pad}-${String(i).padStart(5, '0')}.txt`), `${i}`)
    )
  )
  const { car, out } = await roundTrip(root, dir, 'folder')
  const rootNode = dagPb.decode(
    await readBlock(join(root, 'dfs.car'), car.rootCid.toString())
  )
  assert.equal(
    UnixFS.unmarshal(rootNode.Data as Uint8Array).type,
    'hamt-sharded-directory'
  )
  assert.equal(await readFile(join(out, `${pad}-02999.txt`), 'utf8'), '2999')
})

/** The bytes of block `cid` in the CAR at `path`. */
async function readBlock(path: string, cid: string): Promise<Uint8Array> {
  const blocks = await CarBlockIterator.fromIterable(createReadStream(path))
  for await (const block of blocks) {
    if (block.cid.toString() === cid) return block.bytes
  }
  throw new Error(`no block ${cid}`)
}

test('two packs of a folder are byte-identical', async () => {
  const root = await tempDir()
  const dir = join(root, 'many')
  for (let d = 0; d < 5; d++) {
    await mkdir(join(dir, `d${d}`), { recursive: true })
    for (let f = 0; f < 60; f++) {
      await writeFile(join(dir, `d${d}`, `f${f}`), randomBytes(50 + f * 300))
    }
  }
  await writeFile(join(dir, 'big.bin'), randomBytes(2_200_000))
  const a = await writeCar(await planDirectory(dir), join(root, 'a.car'))
  const planned = await planDirectory(dir)
  const b = await writeCar(planned, join(root, 'b.car'))
  const c = await writeCar(planned, join(root, 'c.car'))
  assert.ok(a.equals(b))
  assert.ok(a.equals(c))
})

test('a source changed between the passes fails with source_changed', async () => {
  const root = await tempDir()
  const dir = join(root, 'site')
  await mkdir(dir)
  const path = join(dir, 'data.bin')
  await writeFile(path, randomBytes(2_100_000))
  const car = await planDirectory(dir)
  const changed = await readFile(path)
  changed[1_500_000] = (changed[1_500_000] ?? 0) ^ 0xff
  await writeFile(path, changed)
  await assert.rejects(writeCar(car, join(root, 'x.car')), {
    code: 'source_changed',
  })

  // A truncated file fails the same way.
  const file = join(root, 'short.bin')
  await writeFile(file, randomBytes(3000))
  const single = await planFile(file)
  await writeFile(file, randomBytes(1000))
  await assert.rejects(writeCar(single, join(root, 'y.car')), {
    code: 'source_changed',
  })
})

test('planning stops past maxSize', async () => {
  const root = await tempDir()
  const path = join(root, 'big.bin')
  await writeFile(path, randomBytes(3 * 1024 * 1024))
  await assert.rejects(planFile(path, { maxSize: 1.5 * 1024 * 1024 }), {
    code: 'invalid_input',
  })
  const car = await planFile(path, { maxSize: 4 * 1024 * 1024 })
  assert.ok(car.size > 3 * 1024 * 1024)
})

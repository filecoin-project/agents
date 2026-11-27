import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CarIndexer } from '@ipld/car'
import { type BufferImporter, importer } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { planDirectory } from '../src/storage/dfs-car.ts'
import { listEntries } from '../src/storage/pack.ts'
import { extractCar, tempDir, writeCar } from './helpers.ts'

/** Create a small site with nested assets, a dotfile, and an empty dir. */
async function site(root: string): Promise<string> {
  const dir = join(root, 'site')
  await mkdir(join(dir, 'assets', 'img'), { recursive: true })
  await mkdir(join(dir, 'empty'))
  await writeFile(join(dir, 'index.html'), '<h1>hello</h1>')
  await writeFile(join(dir, 'assets', 'img', 'big.bin'), randomBytes(2_500_000))
  await writeFile(join(dir, '.env'), 'SECRET=1')
  return dir
}

test('a packed tree extracts without its dotfiles', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const car = await planDirectory(dir)
  assert.equal(car.files, 2)
  await writeCar(car, join(root, 'a.car'))

  const out = join(root, 'out')
  const extracted = await extractCar(
    join(root, 'a.car'),
    car.rootCid.toString(),
    out
  )
  assert.equal(extracted.files, 2)
  assert.deepEqual(
    await readFile(join(out, 'assets', 'img', 'big.bin')),
    await readFile(join(dir, 'assets', 'img', 'big.bin'))
  )
  assert.equal(
    await readFile(join(out, 'index.html'), 'utf8'),
    '<h1>hello</h1>'
  )
  await assert.rejects(readFile(join(out, '.env')), { code: 'ENOENT' })
})

test('listEntries skips dotfiles', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const entries = await listEntries(dir)
  assert.deepEqual(
    entries.files.map((f) => f.path),
    ['assets/img/big.bin', 'index.html']
  )
  assert.deepEqual(entries.directories, ['assets', 'assets/img', 'empty'])
})

test('listEntries reports every symlink at once', async () => {
  const root = await tempDir()
  const dir = await site(root)
  // A link to a file, a broken nested link, and a dot-named link.
  await symlink('/etc/hosts', join(dir, 'hosts'))
  await symlink('missing', join(dir, 'assets', 'img', 'broken'))
  await symlink('/etc/hosts', join(dir, '.hidden'))

  await assert.rejects(listEntries(dir), {
    code: 'invalid_input',
    message:
      'The folder has 2 entries that cannot be uploaded. First: assets/img/broken is a symlink.',
    details: [
      { path: 'path', message: 'assets/img/broken is a symlink' },
      { path: 'path', message: 'hosts is a symlink' },
    ],
  })
})

/** Count the blocks in a CAR file. */
async function countBlocks(carPath: string): Promise<number> {
  const indexer = await CarIndexer.fromIterable(createReadStream(carPath))
  let count = 0
  for await (const _ of indexer) count++
  return count
}

test('a packed folder has no orphan directory blocks', async () => {
  const root = await tempDir()
  const dir = join(root, 'site')
  await mkdir(join(dir, 'assets', 'img'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<h1>hello</h1>')
  // 2.5 MB → three 1 MiB-max raw leaves plus one file node.
  await writeFile(join(dir, 'assets', 'img', 'big.bin'), randomBytes(2_500_000))
  const car = join(root, 'site.car')
  const planned = await planDirectory(dir)
  // 3 directories + index.html + 4 blocks for big.bin
  assert.equal(planned.blocks, 8)
  await writeCar(planned, car)
  assert.equal(await countBlocks(car), 8)
})

test('a packed folder keeps empty directories, including an empty root', async () => {
  const root = await tempDir()
  const dir = join(root, 'blank')
  await mkdir(join(dir, 'nested', 'deeper'), { recursive: true })
  const packed = await planDirectory(dir)
  assert.equal(packed.files, 0)
  await writeCar(packed, join(root, 'blank.car'))
  const out = join(root, 'out')
  await extractCar(join(root, 'blank.car'), packed.rootCid.toString(), out)
  const entries = await listEntries(out)
  assert.deepEqual(entries.directories, ['nested', 'nested/deeper'])

  const empty = join(root, 'empty')
  await mkdir(empty)
  await writeCar(await planDirectory(empty), join(root, 'empty.car'))
  assert.equal(await countBlocks(join(root, 'empty.car')), 1)
})

test('the importer encodes 2–4 GiB file sizes as full varints', async () => {
  // protons-runtime wrote uint64 values in [2^31, 2^32) as one varint byte plus
  // four bytes of stale Buffer pool memory (ipfs/protons#212). Fake three 1 GiB
  // raw leaves so the importer builds a 3 GiB file root without reading data.
  const gib = 2n ** 30n
  const bufferImporter: BufferImporter = async function* () {
    for (let i = 0; i < 3; i++) {
      const digest = await sha256.digest(Uint8Array.of(i))
      const cid = CID.createV1(raw.code, digest)
      yield async () => ({ cid, size: gib, block: new Uint8Array() })
    }
  }
  const blocks = new Map<string, Uint8Array>()
  const blockstore = {
    put(cid: CID, bytes: Uint8Array) {
      blocks.set(cid.toString(), bytes)
      return cid
    },
  }
  // Leave non-zero bytes in the Buffer pool, as a long-running pack would.
  for (let i = 0; i < 256; i++) Buffer.allocUnsafe(64).fill(0xa5)

  let root: CID | undefined
  for await (const entry of importer(
    [{ path: 'big.bin', content: [Uint8Array.of(0)] }],
    blockstore,
    { profile: 'unixfs-v1-2025', bufferImporter }
  )) {
    root = entry.cid
  }
  assert.ok(root)
  const block = blocks.get(root.toString())
  assert.ok(block)
  // dag-pb puts Data (field 1) after the links: type file, filesize 3 GiB,
  // and three 1 GiB block sizes.
  const data = '080218808080800c208080808004208080808004208080808004'
  const hex = Buffer.from(block).toString('hex')
  assert.equal(hex.slice(-4 - data.length), `0a1a${data}`)
})

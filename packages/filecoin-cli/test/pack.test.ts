import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CarIndexer } from '@ipld/car'
import { type BufferImporter, importer } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  extractCar,
  listEntries,
  packDirectory,
  READ_WINDOW,
} from '../src/storage/pack.ts'
import { tempDir } from './helpers.ts'

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

test('packDirectory is deterministic and extractCar restores the tree', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const a = await packDirectory(dir, join(root, 'a.car'))
  const b = await packDirectory(dir, join(root, 'b.car'))
  assert.equal(a.rootCid.toString(), b.rootCid.toString())
  assert.equal(a.files, 2)

  // Measuring without a path gives the written CAR's exact size and root.
  const measured = await packDirectory(dir)
  assert.equal(measured.size, a.size)
  assert.equal(measured.rootCid.toString(), a.rootCid.toString())

  const out = join(root, 'out')
  const extracted = await extractCar(join(root, 'a.car'), out)
  assert.equal(extracted.rootCid.toString(), a.rootCid.toString())
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

test('listEntries skips dotfiles and rejects symlinks', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const entries = await listEntries(dir)
  assert.deepEqual(
    entries.files.map((f) => f.path),
    ['assets/img/big.bin', 'index.html']
  )
  assert.deepEqual(entries.directories, ['assets', 'assets/img', 'empty'])

  await symlink('/etc/hosts', join(dir, 'hosts'))
  await assert.rejects(listEntries(dir), { code: 'invalid_input' })
})

/** Count the blocks in a CAR file. */
async function countBlocks(carPath: string): Promise<number> {
  const indexer = await CarIndexer.fromIterable(createReadStream(carPath))
  let count = 0
  for await (const _ of indexer) count++
  return count
}

test('packDirectory writes no orphan directory blocks', async () => {
  const root = await tempDir()
  const dir = join(root, 'site')
  await mkdir(join(dir, 'assets', 'img'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<h1>hello</h1>')
  // 2.5 MB → three 1 MiB-max raw leaves plus one file node.
  await writeFile(join(dir, 'assets', 'img', 'big.bin'), randomBytes(2_500_000))
  const car = join(root, 'site.car')
  await packDirectory(dir, car)
  // 3 directories + index.html + 4 blocks for big.bin
  assert.equal(await countBlocks(car), 8)
})

test('packDirectory keeps empty directories, including an empty root', async () => {
  const root = await tempDir()
  const dir = join(root, 'blank')
  await mkdir(join(dir, 'nested', 'deeper'), { recursive: true })
  const packed = await packDirectory(dir, join(root, 'blank.car'))
  assert.equal(packed.files, 0)
  const out = join(root, 'out')
  await extractCar(join(root, 'blank.car'), out)
  const entries = await listEntries(out)
  assert.deepEqual(entries.directories, ['nested', 'nested/deeper'])

  const empty = join(root, 'empty')
  await mkdir(empty)
  const packedEmpty = await packDirectory(empty, join(root, 'empty.car'))
  assert.equal(await countBlocks(join(root, 'empty.car')), 1)
  assert.ok(packedEmpty.rootCid)
})

test('extractCar rejects a block that does not match its CID', async () => {
  const root = await tempDir()
  const dir = await site(root)
  const car = join(root, 'site.car')
  const packed = await packDirectory(dir, car)
  // Flip a byte inside big.bin's data, well past the header.
  const handle = await open(car, 'r+')
  try {
    const offset = Math.floor(packed.size / 2)
    const byte = Buffer.alloc(1)
    await handle.read(byte, 0, 1, offset)
    byte[0] = (byte[0] ?? 0) ^ 0xff
    await handle.write(byte, 0, 1, offset)
  } finally {
    await handle.close()
  }
  await assert.rejects(extractCar(car, join(root, 'out')), {
    code: 'verification_failed',
  })
})

test('extractCar restores files larger than one read window', async () => {
  const root = await tempDir()
  const dir = join(root, 'large')
  await mkdir(dir)
  const bytes = randomBytes(READ_WINDOW * 2 + 12_345)
  await writeFile(join(dir, 'blob.bin'), bytes)
  await packDirectory(dir, join(root, 'large.car'))
  await extractCar(join(root, 'large.car'), join(root, 'out'))
  assert.ok(bytes.equals(await readFile(join(root, 'out', 'blob.bin'))))
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

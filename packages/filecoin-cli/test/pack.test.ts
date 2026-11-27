import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { CarIndexer } from '@ipld/car'
import { type BufferImporter, importer } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { planDirectory } from '../src/storage/dfs-car.ts'
import { listEntries } from '../src/storage/pack.ts'
import { extractCar, POSIX_ONLY, tempDir, writeCar } from './helpers.ts'

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

test('includeHidden packs dotfiles and dot-named directories', async () => {
  const root = await tempDir()
  const dir = await site(root)
  await mkdir(join(dir, '.git'))
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main')
  await writeFile(join(dir, 'assets', '.DS_Store'), 'finder')

  const car = await planDirectory(dir, { includeHidden: true })
  assert.equal(car.files, 5)
  await writeCar(car, join(root, 'a.car'))
  const out = join(root, 'out')
  await extractCar(join(root, 'a.car'), car.rootCid.toString(), out)
  for (const path of ['.env', '.git/HEAD', 'assets/.DS_Store']) {
    assert.deepEqual(
      await readFile(join(out, path)),
      await readFile(join(dir, path))
    )
  }
})

test('a hidden root skips nested dotfiles without includeHidden', async () => {
  const dir = join(await tempDir(), '.config')
  await mkdir(dir)
  await writeFile(join(dir, 'a.txt'), 'a')
  await writeFile(join(dir, '.env'), 'SECRET=1')

  const { files } = await listEntries(dir)
  assert.deepEqual(
    files.map((f) => f.path),
    ['a.txt']
  )
  assert.equal((await planDirectory(dir)).files, 1)
  assert.equal((await planDirectory(dir, { includeHidden: true })).files, 2)
})

test(
  'includeHidden rejects unsupported hidden entries',
  POSIX_ONLY,
  async (t) => {
    const dir = join(await tempDir(), 'site')
    await mkdir(join(dir, '.git'), { recursive: true })
    await symlink('/etc/hosts', join(dir, '.link'))
    execFileSync('mkfifo', [join(dir, '.git', 'pipe')])
    await writeFile(join(dir, '.a\\b'), 'a')
    const server = createServer().listen(join(dir, '.sock'))
    t.after(() => server.close())
    await once(server, 'listening')

    // Without the flag, all of them are skipped.
    assert.deepEqual((await listEntries(dir)).files, [])
    await assert.rejects(listEntries(dir, { includeHidden: true }), {
      code: 'invalid_input',
      details: [
        { path: 'path', message: '.a\\b has a backslash in its name' },
        { path: 'path', message: '.git/pipe is a FIFO' },
        { path: 'path', message: '.link is a symlink' },
        { path: 'path', message: '.sock is a socket' },
      ],
    })
  }
)

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

test('listEntries rejects FIFOs and sockets', POSIX_ONLY, async () => {
  const root = await tempDir()
  const dir = await site(root)
  execFileSync('mkfifo', [join(dir, 'assets', 'pipe'), join(dir, '.pipe')])
  const server = createServer()
  server.listen(join(dir, 'sock'))
  await once(server, 'listening')

  try {
    await assert.rejects(listEntries(dir), {
      code: 'invalid_input',
      details: [
        { path: 'path', message: 'assets/pipe is a FIFO' },
        { path: 'path', message: 'sock is a socket' },
      ],
    })
  } finally {
    server.close()
  }
})

test('listEntries rejects names with a backslash', POSIX_ONLY, async () => {
  const root = await tempDir()
  const dir = await site(root)
  await writeFile(join(dir, 'a\\b'), 'a')
  await mkdir(join(dir, 'dir\\'))
  await writeFile(join(dir, 'dir\\', 'f'), 'f')
  await symlink('f', join(dir, 'dir\\', 'link'))
  await writeFile(join(dir, '.a\\b'), 'hidden')

  await assert.rejects(listEntries(dir), {
    code: 'invalid_input',
    details: [
      { path: 'path', message: 'a\\b has a backslash in its name' },
      { path: 'path', message: 'dir\\ has a backslash in its name' },
      { path: 'path', message: 'dir\\/link is a symlink' },
    ],
  })
})

test(
  'an unreadable rejected directory is still reported',
  POSIX_ONLY,
  async () => {
    const root = await tempDir()
    const dir = await site(root)
    // One that cannot be listed, and one whose entries cannot be read.
    const locked = join(dir, 'a\\')
    const listOnly = join(dir, 'b\\')
    for (const path of [locked, listOnly]) {
      await mkdir(path)
      await writeFile(join(path, 'f'), 'f')
    }
    // One with a supported name, below a rejected directory.
    const nested = join(dir, 'c\\', 'sub')
    await mkdir(nested, { recursive: true })
    await symlink('missing', join(dir, 'link'))
    await chmod(nested, 0o000)
    await chmod(locked, 0o000)
    await chmod(listOnly, 0o400)

    try {
      await assert.rejects(listEntries(dir), {
        code: 'invalid_input',
        details: [
          { path: 'path', message: 'a\\ has a backslash in its name' },
          { path: 'path', message: 'b\\ has a backslash in its name' },
          { path: 'path', message: 'c\\ has a backslash in its name' },
          { path: 'path', message: 'link is a symlink' },
        ],
      })
    } finally {
      await chmod(locked, 0o700)
      await chmod(listOnly, 0o700)
      await chmod(nested, 0o700)
    }
  }
)

test(
  'a folder name may hold a backslash but not end in one',
  POSIX_ONLY,
  async () => {
    const root = await tempDir()
    const inside = join(root, 'a\\b')
    await mkdir(inside)
    await writeFile(join(inside, 'f'), 'f')
    assert.equal((await planDirectory(inside)).files, 1)

    const last = join(root, 'a\\')
    await mkdir(last)
    await assert.rejects(planDirectory(last), { code: 'invalid_input' })
    await writeFile(join(last, 'f'), 'f')
    await assert.rejects(planDirectory(last), {
      code: 'invalid_input',
      message: /ends in a backslash/,
    })
  }
)

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

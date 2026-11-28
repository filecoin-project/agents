import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  KeyResolver,
  RandomAccessSource,
} from 'filecoin-encryption-envelope'
import * as fee from 'filecoin-encryption-envelope'
import { type Archive, openArchive } from '../src/archive.ts'
import { carHeader, emitInnerCar, planInnerCar } from '../src/car/index.ts'
import {
  CAR_CONTENT_TYPE,
  CHUNK_SIZE,
  encrypt,
  encryptPlan,
  ownerKeyResolver,
  readEnvelopeHeader,
} from '../src/envelope.ts'
import { DecryptError } from '../src/errors.ts'
import { OWNER, STRANGER } from './fixtures/keys.ts'
import {
  collect,
  concat,
  fixture,
  memoryInput,
  randomBytes,
  sameBytes,
  text,
} from './helpers.ts'

/** A plaintext name that must never reach an error message. */
const SECRET = 'payroll-2026-secret'
const BIG = new Uint8Array(randomBytes(CHUNK_SIZE * 40 + 1234))
const TREE = {
  [SECRET]: null,
  [`${SECRET}/a.txt`]: 'alpha',
  [`${SECRET}/big.bin`]: BIG,
  [`${SECRET}/empty`]: null,
  [`${SECRET}/zero.txt`]: '',
}

/** Pack and encrypt `tree` with the owner wallet. */
async function seal(tree: Record<string, Uint8Array | string | null>) {
  const { input, source } = memoryInput(tree)
  const plan = await planInnerCar(input, source)
  const { envelope } = await encryptPlan(plan, source, {
    credentials: { owner: OWNER },
    dataSets: [],
  })
  return { bytes: await collect(envelope), plan }
}

/** A range source over `bytes` that counts what it serves, and can cut every range short. */
function rangeSource(bytes: Uint8Array, cut = 0) {
  const counter = { served: 0 }
  const source: RandomAccessSource = {
    size: bytes.length,
    openRange(offset, length) {
      const end = Math.max(offset, offset + length - cut)
      counter.served += end - offset
      return Promise.resolve(new Blob([bytes.slice(offset, end)]).stream())
    },
  }
  return { source, counter }
}

/** A resolver that remembers the key it handed out. */
function watched(resolver: KeyResolver) {
  const seen: { key?: Uint8Array } = {}
  const resolve: KeyResolver = async (info) => {
    seen.key = await resolver(info)
    return seen.key
  }
  return { resolve, seen }
}

/** Assert an archive call fails with `code`, naming nothing from inside. */
async function fails(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DecryptError, String(error))
    assert.equal(error.code, code)
    assert.ok(!error.message.includes(SECRET), error.message)
    return true
  })
}

const readAll = (archive: Archive, path: string) => collect(archive.open(path))

describe('openArchive', () => {
  test("a resolver's format 1 refusal is format-1, as decrypt reports it", async () => {
    const { bytes } = await seal(TREE)
    await fails(
      openArchive(bytes, () =>
        Promise.reject(
          new Error(
            'keysmith 0.1.0 (format 1) data is not supported: a piece with foc/ks labels'
          )
        )
      ),
      'format-1'
    )
  })

  test('lists the tree and reads each file', async () => {
    const { bytes } = await seal(TREE)
    const archive = await openArchive(bytes, ownerKeyResolver(OWNER))
    assert.equal(archive.name, SECRET)
    assert.equal(archive.kind, 'directory')
    assert.deepEqual(
      archive.list().map((e) => [e.path, e.directory, e.size]),
      [
        [SECRET, true, 0],
        [`${SECRET}/a.txt`, false, 5],
        [`${SECRET}/big.bin`, false, BIG.length],
        [`${SECRET}/empty`, true, 0],
        [`${SECRET}/zero.txt`, false, 0],
      ]
    )
    assert.equal(text(await readAll(archive, `${SECRET}/a.txt`)), 'alpha')
    assert.ok(sameBytes(await readAll(archive, `${SECRET}/big.bin`), BIG))
    assert.equal((await readAll(archive, `${SECRET}/zero.txt`)).length, 0)
    archive.close()
  })

  test('lists a folder of empty folders, which has no leaf', async () => {
    const { bytes, plan } = await seal({ d: null, 'd/e': null })
    assert.equal(plan.layout.leaves.length, 0)
    const archive = await openArchive(bytes, ownerKeyResolver(OWNER))
    assert.deepEqual(
      archive.list().map((e) => [e.path, e.directory]),
      [
        ['d', true],
        ['d/e', true],
      ]
    )
    archive.close()
  })

  test('reads one small file without decrypting the rest', async () => {
    const { bytes } = await seal(TREE)
    const { source, counter } = rangeSource(bytes)
    const archive = await openArchive(source, ownerKeyResolver(OWNER))
    await readAll(archive, `${SECRET}/a.txt`)
    assert.ok(
      counter.served < bytes.length / 4,
      `served ${counter.served} of ${bytes.length}`
    )
    archive.close()
  })

  test('reads a single file and filecoin-pin golden envelope', async () => {
    const single = await seal({ 'one.txt': 'just one' })
    const one = await openArchive(single.bytes, ownerKeyResolver(OWNER))
    assert.equal(one.kind, 'file')
    assert.equal(text(await readAll(one, 'one.txt')), 'just one')
    one.close()

    const golden = await fixture('report.fee')
    const report = await openArchive(golden, ownerKeyResolver(OWNER))
    assert.equal(
      text(await readAll(report, 'report/hello.txt')),
      'hello, filecoin\n'
    )
    assert.equal(text(await readAll(report, 'report/notes/a.md')), '# a\n')
    report.close()
  })

  test('zeroes the key on close, and refuses reads after it', async () => {
    const { bytes } = await seal(TREE)
    const { resolve, seen } = watched(ownerKeyResolver(OWNER))
    const archive = await openArchive(bytes, resolve)
    archive.close()
    assert.ok(seen.key?.every((b) => b === 0))
    assert.throws(() => archive.open(`${SECRET}/a.txt`), {
      code: 'archive-closed',
    })
  })

  test('zeroes the key when opening fails, and names nothing from inside', async () => {
    const { bytes } = await seal(TREE)
    const tampered = bytes.slice()
    tampered[tampered.length - 100] ^= 1
    // The last chunk holds leaves only, so the prefix still opens; a read of the big file fails.
    const archive = await openArchive(tampered, ownerKeyResolver(OWNER))
    await fails(readAll(archive, `${SECRET}/big.bin`), 'wrong-key-or-modified')
    archive.close()

    // A byte of the first chunk, which holds the dag-pb prefix.
    const header = await readEnvelopeHeader(bytes)
    const early = bytes.slice()
    early[(header?.headerLength ?? 0) + 10] ^= 1
    const { resolve, seen } = watched(ownerKeyResolver(OWNER))
    await fails(openArchive(early, resolve), 'wrong-key-or-modified')
    assert.ok(seen.key?.every((b) => b === 0))
  })

  test('another wallet gets the key error, and a short range is worth retrying', async () => {
    const { bytes } = await seal(TREE)
    await fails(openArchive(bytes, ownerKeyResolver(STRANGER)), 'not-owner')
    const { source } = rangeSource(bytes, 1)
    await fails(
      openArchive(source, ownerKeyResolver(OWNER)),
      'incomplete-download'
    )
  })

  test('an envelope of another length than its header says is modified, not worth retrying', async () => {
    const { bytes } = await seal(TREE)
    const padded = new Uint8Array(bytes.length + 1)
    padded.set(bytes)
    await fails(
      openArchive(padded, ownerKeyResolver(OWNER)),
      'wrong-key-or-modified'
    )
    await fails(
      openArchive(bytes.subarray(0, bytes.length - 1), ownerKeyResolver(OWNER)),
      'wrong-key-or-modified'
    )
  })

  test('refuses a limit that is not a whole number before any read', async () => {
    const { bytes } = await seal(TREE)
    const { source, counter } = rangeSource(bytes)
    for (const options of [
      { maxMetadataBytes: Number.NaN },
      { maxMetadataBytes: -100 },
      { maxVisits: Number.NaN },
    ]) {
      await assert.rejects(
        openArchive(source, ownerKeyResolver(OWNER), options),
        RangeError
      )
    }
    assert.equal(counter.served, 0)
  })

  test('refuses a CAR header that is not a map', async () => {
    for (const header of [
      [1, 0x01],
      [1, 0xf6],
      [2, 0x41, 0],
      // A 1,000-byte header, refused before its body is decoded.
      [0xe8, 0x07, ...new Uint8Array(1000)],
    ]) {
      const inner = Uint8Array.from(header)
      const { envelope } = await encrypt(inner, {
        credentials: { owner: OWNER },
        dataSets: [],
        contentLength: inner.length,
      })
      await fails(
        openArchive(await collect(envelope), ownerKeyResolver(OWNER)),
        'not-metadata-first'
      )
    }
  })

  test('refuses an inner CAR that is not metadata-first', async () => {
    const { plan } = await seal({ d: null, 'd/a': 'alpha' })
    const { source } = memoryInput({ d: null, 'd/a': 'alpha' })
    const inner = await collect(emitInnerCar(plan, source))
    // The same blocks with the leaf first.
    const leaf = plan.layout.leaves[0]
    const node = plan.layout.metadata
    assert.ok(leaf != null)
    const leafSection = inner.slice(leaf.offset, leaf.dataOffset + leaf.len)
    const nodes = inner.slice(
      node[0]?.offset ?? 0,
      (node.at(-1)?.offset ?? 0) + (node.at(-1)?.len ?? 0)
    )
    const header = carHeader(plan.root)
    const reordered = concat([header, leafSection, nodes])
    assert.equal(reordered.length, inner.length)
    const { envelope } = await encrypt([reordered], {
      contentLength: reordered.length,
      credentials: { owner: OWNER },
      dataSets: [],
    })
    await fails(
      openArchive(await collect(envelope), ownerKeyResolver(OWNER)),
      'not-metadata-first'
    )
  })

  test('charges only metadata to the budget, and all of it', async () => {
    // A file of 72 KiB has a small prefix: its leaf doesn't count against 4 KiB.
    const file = await seal({
      'one.bin': new Uint8Array(randomBytes(72 * 1024)),
    })
    const one = await openArchive(file.bytes, ownerKeyResolver(OWNER), {
      maxMetadataBytes: 4096,
    })
    assert.equal((await readAll(one, 'one.bin')).length, 72 * 1024)
    one.close()
    // A folder whose sections each fit in 256 bytes but together don't.
    const { bytes, plan } = await seal(TREE)
    const prefix = plan.layout.metadata.at(-1)
    assert.ok(prefix != null && prefix.offset + prefix.len > 256)
    await fails(
      openArchive(bytes, ownerKeyResolver(OWNER), { maxMetadataBytes: 256 }),
      'layout-limit'
    )
  })

  test('refuses a tree past its limits', async () => {
    const { bytes } = await seal(TREE)
    await fails(
      openArchive(bytes, ownerKeyResolver(OWNER), { maxEntries: 2 }),
      'layout-limit'
    )
    await fails(
      openArchive(bytes, ownerKeyResolver(OWNER), { maxMetadataBytes: 64 }),
      'layout-limit'
    )
  })

  /**
   * A range source that serves the prefix, then, once `held`, waits for
   * `release()` and sends 1 KiB of each range and nothing more.
   */
  function slowSource(bytes: Uint8Array) {
    const state = {
      held: false,
      opened: false,
      pulled: false,
      cancelled: false,
      release: (): void => undefined,
    }
    const source: RandomAccessSource = {
      size: bytes.length,
      async openRange(offset, length) {
        const part = bytes.slice(offset, offset + length)
        if (!state.held) return new Blob([part]).stream()
        state.opened = true
        await new Promise<void>((resolve) => {
          state.release = resolve
        })
        let sent = false
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(part.subarray(0, 1024))
              return
            }
            // The rest never arrives: the read stays open until it is cancelled.
            state.pulled = true
            return new Promise(() => undefined)
          },
          cancel() {
            state.cancelled = true
          },
        })
      },
    }
    return { source, state }
  }

  /** Wait for `ready`, for at most about 5 seconds. */
  const until = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 5000 && !ready(); i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(ready(), 'timed out')
  }

  test('close() during a read cancels the range read and releases nothing more', async () => {
    const { bytes } = await seal(TREE)
    const { source, state } = slowSource(bytes)
    const archive = await openArchive(source, ownerKeyResolver(OWNER))
    state.held = true
    const reading = readAll(archive, `${SECRET}/big.bin`)
    await until(() => state.opened)
    archive.close()
    state.release()
    await fails(reading, 'archive-closed')
    await until(() => state.cancelled)
  })

  test('cancelling a file stream cancels its range read', async () => {
    const { bytes } = await seal(TREE)
    const { source, state } = slowSource(bytes)
    const archive = await openArchive(source, ownerKeyResolver(OWNER))
    state.held = true
    const reader = archive.open(`${SECRET}/big.bin`).getReader()
    const pending = reader.read().catch(() => undefined)
    await until(() => state.opened)
    state.release()
    // The range read has its first KiB and waits for more: the file stream is mid-read.
    await until(() => state.pulled)
    await reader.cancel()
    await pending
    assert.equal(state.cancelled, true)
    archive.close()
  })

  test("checks each leaf section's varint and CID, as the unpacker does", async () => {
    const { plan } = await seal({ d: null, 'd/a': 'alpha' })
    const { source } = memoryInput({ d: null, 'd/a': 'alpha' })
    const inner = await collect(emitInnerCar(plan, source))
    const leaf = plan.layout.leaves[0]
    assert.ok(leaf != null)
    // The last byte of the leaf's CID on the wire; the directory still links the right one.
    inner[leaf.dataOffset - 1] ^= 1
    const { envelope } = await encrypt([inner], {
      contentLength: inner.length,
      credentials: { owner: OWNER },
      dataSets: [],
    })
    const archive = await openArchive(
      await collect(envelope),
      ownerKeyResolver(OWNER)
    )
    await fails(readAll(archive, 'd/a'), 'not-metadata-first')
    archive.close()
  })

  test('refuses a batch smaller than one leaf, an empty plaintext, and an envelope with no labels, before asking for a key', async () => {
    const { bytes } = await seal(TREE)
    await assert.rejects(
      openArchive(bytes, ownerKeyResolver(OWNER), { maxBatchBytes: 1024 }),
      RangeError
    )
    await assert.rejects(
      openArchive(bytes, ownerKeyResolver(OWNER), {
        maxBatchBytes: 1049000.5,
      }),
      RangeError
    )
    const { resolve, seen } = watched(ownerKeyResolver(OWNER))
    const empty = fee.encrypt({
      cek: new Uint8Array(randomBytes(32)),
      contentLength: 0,
      contentType: CAR_CONTENT_TYPE,
      appMetadata: { 'foc/v': '2' },
    })
    await fails(
      openArchive(
        await collect(new Blob([]).stream().pipeThrough(empty)),
        resolve
      ),
      'not-encrypted'
    )
    assert.equal(seen.key, undefined)
    const unlabeled = fee.encrypt({
      cek: new Uint8Array(randomBytes(32)),
      contentLength: 5,
      contentType: CAR_CONTENT_TYPE,
    })
    await fails(
      openArchive(
        await collect(
          new Blob([new Uint8Array(5)]).stream().pipeThrough(unlabeled)
        ),
        ownerKeyResolver(OWNER)
      ),
      'not-encrypted'
    )
  })

  test('close() drops the leaves a file stream has queued', async () => {
    const { bytes } = await seal(TREE)
    const archive = await openArchive(bytes, ownerKeyResolver(OWNER))
    const reader = archive.open(`${SECRET}/big.bin`).getReader()
    // One pull decrypts a batch of several leaves and queues them all.
    const first = await reader.read()
    assert.equal(first.done, false)
    // The first read resolves at the first leaf; give the pull time to queue the rest.
    await new Promise((resolve) => setTimeout(resolve, 300))
    archive.close()
    await fails(reader.read(), 'archive-closed')
  })

  test('a file stream cancelled while FEE imports the key starts no range request', async () => {
    const { bytes } = await seal(TREE)
    const { source, counter } = rangeSource(bytes)
    const archive = await openArchive(source, ownerKeyResolver(OWNER))
    const before = counter.served
    const reader = archive.open(`${SECRET}/big.bin`).getReader()
    const pending = reader.read().catch(() => undefined)
    // Let the pull start and wait on the key import, then cancel.
    await Promise.resolve()
    await Promise.resolve()
    await reader.cancel()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(counter.served, before)
    archive.close()
  })

  test('a file stream closes with its last leaf, without another read', async () => {
    const { bytes } = await seal(TREE)
    const archive = await openArchive(bytes, ownerKeyResolver(OWNER))
    const reader = archive.open(`${SECRET}/a.txt`).getReader()
    const { value } = await reader.read()
    assert.equal(text(value), 'alpha')
    await reader.closed
    archive.close()
  })

  test('reads a repeated chunk once, not once per repeat', async () => {
    const chunk = new Uint8Array(randomBytes(1024 * 1024))
    const repeated = new Uint8Array(8 * chunk.length)
    for (let i = 0; i < 8; i++) repeated.set(chunk, i * chunk.length)
    const { bytes } = await seal({ 'zeros.bin': repeated })
    const { source, counter } = rangeSource(bytes)
    let requests = 0
    const counting: RandomAccessSource = {
      size: source.size,
      openRange(offset, length) {
        requests++
        return source.openRange(offset, length)
      },
    }
    const archive = await openArchive(counting, ownerKeyResolver(OWNER))
    const before = { requests, served: counter.served }
    const read = await readAll(archive, 'zeros.bin')
    assert.ok(sameBytes(read, repeated))
    assert.equal(requests - before.requests, 1)
    assert.ok(counter.served - before.served < 2 * chunk.length)
    archive.close()
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CarBlockIterator } from '@ipld/car/iterator'
import { sha256 } from 'multiformats/hashes/sha2'
import { emitInnerCar, planInnerCar } from '../src/car/index.ts'
import {
  decrypt,
  decryptToSink,
  ownerKeyResolver,
  readEnvelopeHeader,
} from '../src/envelope.ts'
import { OWNER, VECTOR_GROUP_KEY } from './fixtures/keys.ts'
import {
  bigInput,
  collect,
  fixture,
  hexOf,
  memoryInput,
  memorySink,
  sameBytes,
  streamOf,
  text,
} from './helpers.ts'

/** The input of `report.fee`, as filecoin-pin's decrypt test pins it. */
const REPORT = {
  report: null,
  'report/empty.bin': '',
  'report/hello.txt': 'hello, filecoin\n',
  'report/notes': null,
  'report/notes/a.md': '# a\n',
}

/** Decrypt an envelope to its inner CAR bytes with the owner wallet. */
const innerCar = (envelope: Uint8Array): Promise<Uint8Array> =>
  collect(decrypt(streamOf(envelope), ownerKeyResolver(OWNER)))

describe('filecoin-pin golden envelopes', () => {
  test('report.fee opens with the Anvil owner key and restores its tree', async () => {
    const envelope = await fixture('report.fee')
    const header = await readEnvelopeHeader(envelope)
    assert.equal(header?.view.groupKeyId, VECTOR_GROUP_KEY)
    assert.equal(header?.view.salt, '0x000102030405060708090a0b0c0d0e0f')

    const sink = memorySink()
    const result = await decryptToSink(
      streamOf(envelope),
      ownerKeyResolver(OWNER),
      sink
    )

    assert.deepEqual(result, {
      name: 'report',
      kind: 'directory',
      files: 3,
      dirs: 2,
      bytes: 20,
    })
    assert.deepEqual(sink.dirs, ['report', 'report/notes'])
    assert.equal(text(sink.files.get('report/hello.txt')), 'hello, filecoin\n')
    assert.equal(text(sink.files.get('report/notes/a.md')), '# a\n')
    assert.equal(sink.files.get('report/empty.bin')?.length, 0)
  })

  test('big.fee opens across several chunks and pins its inner root and content', async () => {
    const envelope = await fixture('big.fee')
    const sink = memorySink()
    const result = await decryptToSink(
      streamOf(envelope),
      ownerKeyResolver(OWNER),
      sink
    )

    assert.deepEqual(result, {
      name: 'big.bin',
      kind: 'file',
      files: 1,
      dirs: 0,
      bytes: 1_100_000,
    })
    const content = sink.files.get('big.bin') ?? new Uint8Array()
    assert.equal(
      hexOf((await sha256.digest(content)).digest),
      '055f73580b10983d35429f869533fa41074a23477646ad9d09264b8be2fcc936'
    )
    assert.deepEqual(content, bigInput())
    const roots = await (
      await CarBlockIterator.fromBytes(await innerCar(envelope))
    ).getRoots()
    assert.deepEqual(roots.map(String), [
      'bafybeifi5o5cikl37er2zmvmbwgcsoh5df7q2q4soo6iwvlit7nstujohm',
    ])
  })

  // FEE draws a random nonce, so only the inner CAR is deterministic.
  for (const [name, tree] of [
    ['report.fee', REPORT],
    ['big.fee', { 'big.bin': bigInput() }],
  ] as const) {
    test(`the inner CAR rebuilt from ${name}'s input is byte-identical`, async () => {
      const { input, source } = memoryInput(tree)
      const plan = await planInnerCar(input, source)
      const rebuilt = await collect(emitInnerCar(plan, source))
      const golden = await innerCar(await fixture(name))

      assert.equal(plan.contentLength, golden.length)
      assert.equal(rebuilt.length, golden.length)
      assert.ok(sameBytes(rebuilt, golden))
    })
  }
})

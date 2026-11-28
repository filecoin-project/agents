import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { GroupKeyChoiceError } from '../src/errors.ts'
import {
  chooseGroupKey,
  type DataSetInfo,
  dataSetVisibility,
  defaultGroupKeyId,
  ENCRYPTED_DATA_SET_KEYS,
  encryptedDataSetMetadata,
  isEncryptedDataSet,
  oldestValidGroupKey,
  type SkippedGroupKey,
} from '../src/group-key.ts'
import { GROUP_KEY, OWNER } from './fixtures/keys.ts'

const A = `0x${'aa'.repeat(16)}` as const
const B = `0x${'bb'.repeat(16)}` as const
const encrypted = (
  dataSetId: bigint,
  gkid: string,
  kc = `v2.${'11'.repeat(16)}`,
  extra = {}
): DataSetInfo => ({
  dataSetId,
  metadata: { 'foc/enc': '1', 'foc/gkid': gkid, 'foc/kc': kc, ...extra },
})

describe('defaultGroupKeyId', () => {
  test("matches the console's and filecoin-pin's id for the Anvil owner, in any case", () => {
    assert.equal(defaultGroupKeyId(OWNER.address), GROUP_KEY)
    assert.equal(
      defaultGroupKeyId(OWNER.address.toLowerCase() as `0x${string}`),
      GROUP_KEY
    )
    assert.throws(() => defaultGroupKeyId('0x1234'), { code: 'bad-address' })
  })
})

describe('encrypted data set metadata', () => {
  test('carries foc/enc "1", foc/gkid, and foc/kc', () => {
    const kc = `v2.${'0f'.repeat(16)}`
    assert.deepEqual(
      encryptedDataSetMetadata({ owner: OWNER.address, groupKeyId: A }, kc),
      {
        'foc/enc': '1',
        'foc/gkid': A,
        'foc/kc': kc,
      }
    )
  })

  test('any encrypted key, the legacy foc/ks included, marks a data set as encrypted', () => {
    assert.deepEqual(
      [...ENCRYPTED_DATA_SET_KEYS],
      ['foc/gkid', 'foc/ks', 'foc/kc', 'foc/enc']
    )
    for (const key of ENCRYPTED_DATA_SET_KEYS)
      assert.equal(isEncryptedDataSet({ [key]: 'x' }), true)
    assert.equal(isEncryptedDataSet({ source: 'filecoin-cli' }), false)
  })

  test('visibility follows read and foc/enc', () => {
    assert.equal(dataSetVisibility({}), 'public')
    assert.equal(dataSetVisibility({ 'foc/ks': 'x' }), 'public encrypted')
    assert.equal(
      dataSetVisibility({ read: 'restricted', 'foc/enc': '1' }),
      'private'
    )
    assert.equal(
      dataSetVisibility({ read: 'restricted' }),
      'unknown visibility'
    )
  })
})

describe('chooseGroupKey', () => {
  test("picks the owner's default group key when no data set records one", () => {
    assert.deepEqual(
      chooseGroupKey(OWNER.address, [{ dataSetId: 1n, metadata: {} }]),
      { groupKeyId: GROUP_KEY }
    )
  })

  test('picks the valid group key with the lowest data set id, with its commitment', () => {
    const sets = [
      encrypted(9n, B, `v2.${'0b'.repeat(16)}`),
      encrypted(4n, A, `v2.${'0a'.repeat(16)}`),
      encrypted(2n, B, `v2.${'0b'.repeat(16)}`),
    ]
    assert.deepEqual(chooseGroupKey(OWNER.address, sets), {
      groupKeyId: B,
      commitment: `v2.${'0b'.repeat(16)}`,
    })
  })

  test('skips inconsistent and non-canonical group keys and says why', () => {
    const skipped: SkippedGroupKey[] = []
    const sets = [
      encrypted(1n, A, `v2.${'0a'.repeat(16)}`),
      encrypted(2n, A, `v2.${'0e'.repeat(16)}`),
      encrypted(3n, B.toUpperCase().replace('0X', '0x')),
      {
        dataSetId: 4n,
        metadata: { 'foc/gkid': GROUP_KEY, 'foc/kc': `v2.${'0c'.repeat(16)}` },
      },
      encrypted(5n, `0x${'cc'.repeat(16)}`, `v2.${'0c'.repeat(16)}`),
      { ...encrypted(0n, `0x${'dd'.repeat(16)}`), isLive: false },
    ]
    assert.equal(
      oldestValidGroupKey(sets, (s) => skipped.push(s))?.groupKeyId,
      `0x${'cc'.repeat(16)}`
    )
    assert.deepEqual(
      skipped.map((s) => [s.reason, s.dataSetIds]),
      [
        ['inconsistent', [1n, 2n]],
        ['non-canonical-id', [3n]],
        ['inconsistent', [4n]],
      ]
    )
  })

  test('skips a group key whose foc/kc Keysmith cannot check a key against', () => {
    const skipped: SkippedGroupKey[] = []
    const sets = [
      encrypted(1n, A, 'v2.b'),
      encrypted(2n, B, `v1.${'11'.repeat(16)}`),
      encrypted(3n, `0x${'cc'.repeat(16)}`, `V2.${'11'.repeat(16)}`),
      encrypted(4n, `0x${'dd'.repeat(16)}`),
    ]
    assert.deepEqual(
      chooseGroupKey(OWNER.address, sets, (s) => skipped.push(s)),
      {
        groupKeyId: `0x${'dd'.repeat(16)}`,
        commitment: `v2.${'11'.repeat(16)}`,
      }
    )
    assert.deepEqual(
      skipped.map((s) => [s.reason, s.dataSetIds]),
      [
        ['bad-commitment', [1n]],
        ['bad-commitment', [2n]],
        ['bad-commitment', [3n]],
      ]
    )
    // With no valid group key left, the default id still can't be grown.
    assert.throws(
      () => chooseGroupKey(OWNER.address, [encrypted(5n, GROUP_KEY, 'v2.b')]),
      { code: 'invalid-default-group-key' }
    )
  })

  test('refuses to grow an invalid default group key', () => {
    const sets = [
      {
        dataSetId: 7n,
        metadata: { 'foc/gkid': GROUP_KEY, 'foc/kc': `v2.${'0c'.repeat(16)}` },
      },
    ]
    assert.throws(
      () => chooseGroupKey(OWNER.address, sets),
      (error: unknown) =>
        error instanceof GroupKeyChoiceError &&
        error.code === 'invalid-default-group-key' &&
        error.dataSetIds.includes(7n)
    )
  })
})

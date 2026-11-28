import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deriveGroupKey } from '@filoz/keysmith'
import * as fee from 'filecoin-encryption-envelope'
import { emitInnerCar, planInnerCar, unpackInnerCar } from '../src/car/index.ts'
import {
  CAR_CONTENT_TYPE,
  CHUNK_SIZE,
  type Credentials,
  credentialKeyResolver,
  decrypt,
  decryptToSink,
  encrypt,
  encryptPlan,
  isEnvelope,
  ownerKeyResolver,
  readEnvelopeHeader,
  toDecryptError,
  wrapOverhead,
} from '../src/envelope.ts'
import {
  DecryptError,
  EncryptionError,
  errorCode,
  NotOwnerError,
} from '../src/errors.ts'
import { checkGroup } from '../src/group-key.ts'
import { grantForWrite, openSessionGrants } from '../src/keys.ts'
import {
  CALIBRATION_CHAIN_ID,
  FAR_FUTURE,
  GROUP_KEY,
  makeGrant,
  OTHER_SESSION_KEY,
  OWNER,
  SESSION_KEY,
  STRANGER,
} from './fixtures/keys.ts'
import {
  collect,
  hasBytes,
  memoryInput,
  memorySink,
  randomBytes,
  sameBytes,
  streamOf,
} from './helpers.ts'

/** A plaintext name that must never reach an error message. */
const SECRET = 'payroll-2026-secret'
const TREE = {
  [SECRET]: null,
  [`${SECRET}/a.txt`]: 'alpha',
  [`${SECRET}/big.bin`]: new Uint8Array(randomBytes(CHUNK_SIZE * 2 + 1234)),
  [`${SECRET}/empty`]: null,
}

const owner: Credentials = { owner: OWNER }
const session = async (
  group?: string,
  sessionKey = SESSION_KEY
): Promise<Credentials> => ({
  session: {
    sessionKey,
    walletAddress: OWNER.address,
    chainId: CALIBRATION_CHAIN_ID,
    groupKeyId: GROUP_KEY,
    grants: [await makeGrant({ ...(group != null && { group }) })],
  },
})

/** Pack and encrypt `TREE` with `credentials`; returns the envelope bytes and the labels. */
async function seal(credentials: Credentials, group?: string) {
  const { input, source } = memoryInput(TREE)
  const plan = await planInnerCar(input, source)
  const sealed = await encryptPlan(plan, source, {
    credentials,
    dataSets: [],
    group,
  })
  return { ...sealed, bytes: await collect(sealed.envelope), plan }
}

/** Decrypt and unpack, returning the sink, or the error. */
async function open(bytes: Uint8Array, credentials: Credentials | undefined) {
  const sink = memorySink()
  const result = await decryptToSink(
    streamOf(bytes),
    credentialKeyResolver(credentials),
    sink
  )
  return { sink, result }
}

/** Assert a decryption fails with `code`, and that its message names nothing from inside. */
async function fails(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DecryptError, String(error))
    assert.equal(error.code, code)
    assert.ok(!error.message.includes(SECRET), error.message)
    assert.ok(!/baf[a-z0-9]{20,}/.test(error.message), error.message)
    return true
  })
}

describe('encrypt and decrypt', () => {
  test('round-trips a folder with the owner wallet', async () => {
    const { bytes, labels, dataSetMetadata } = await seal(owner)
    const { commitment } = await deriveGroupKey(OWNER, {
      owner: OWNER.address,
      groupKeyId: GROUP_KEY,
    })

    assert.equal(labels['foc/gkid'], GROUP_KEY)
    assert.equal(labels['foc/own'], OWNER.address.toLowerCase())
    assert.deepEqual(dataSetMetadata, {
      'foc/enc': '1',
      'foc/gkid': GROUP_KEY,
      'foc/kc': commitment,
    })
    const { sink, result } = await open(bytes, owner)
    assert.equal(result.name, SECRET)
    assert.deepEqual(
      sink.files.get(`${SECRET}/big.bin`),
      TREE[`${SECRET}/big.bin`]
    )
    assert.deepEqual(sink.dirs, [SECRET, `${SECRET}/empty`])
  })

  test('writes the header filecoin-pin reads: content type, chunk size, length, labels', async () => {
    const { bytes, labels, plan } = await seal(owner)
    const header = await readEnvelopeHeader(bytes)

    assert.deepEqual({ ...header?.labels }, labels)
    assert.equal(header?.plaintextLength, plan.contentLength)
    assert.equal(await isEnvelope(bytes), true)
    assert.ok(
      bytes.length - plan.contentLength <= wrapOverhead(plan.contentLength)
    )
    assert.ok(
      !hasBytes(bytes, new TextEncoder().encode(SECRET)),
      'the name is inside the ciphertext'
    )
    assert.equal(CAR_CONTENT_TYPE, 'application/vnd.ipld.car')
  })

  test("budgets the group's bytes in the header", async () => {
    const group = 'g'.repeat(8192)
    const { bytes, plan } = await seal(owner, group)
    const added = bytes.length - plan.contentLength
    assert.ok(added > wrapOverhead(plan.contentLength), 'the group is large')
    assert.ok(added <= wrapOverhead(plan.contentLength, group))
    // NFC turns U+0958 (3 bytes) into U+0915 U+093C (6 bytes): the header carries the longer form.
    const expands = '\u0958'.repeat(3000)
    const sealed = await seal(owner, expands)
    assert.ok(
      sealed.bytes.length - sealed.plan.contentLength <=
        wrapOverhead(sealed.plan.contentLength, expands)
    )
  })

  test('derives a fresh piece key per object: the same input encrypts differently', async () => {
    const first = await seal(owner)
    const second = await seal(owner)
    assert.notEqual(first.labels['foc/salt'], second.labels['foc/salt'])
    assert.ok(!sameBytes(first.bytes, second.bytes))
  })

  test('round-trips with a session key Grant, under a group, and the owner opens it too', async () => {
    const credentials = await session('team')
    const { bytes, labels } = await seal(credentials, 'team/a')
    assert.equal(labels['foc/group'], 'team/a')
    assert.equal((await open(bytes, credentials)).result.files, 2)
    assert.equal((await open(bytes, owner)).result.files, 2)
  })

  test('a session key writes only where a Grant reaches, and checks the chain agrees', async () => {
    const credentials = await session('team')
    await assert.rejects(seal(credentials, 'other'), {
      code: 'no-grant-for-group',
    })
    const disagreeing = [
      {
        dataSetId: 3n,
        metadata: { 'foc/enc': '1', 'foc/gkid': GROUP_KEY, 'foc/kc': 'v2.00' },
      },
    ]
    const { input, source } = memoryInput(TREE)
    const plan = await planInnerCar(input, source)
    await assert.rejects(
      encryptPlan(plan, source, { credentials, dataSets: disagreeing }),
      { code: 'chain-disagrees' }
    )
  })

  test('a bad group fails as bad-group before the owner wallet signs', async () => {
    let signatures = 0
    const counting: Credentials = {
      owner: {
        address: OWNER.address,
        signTypedData: (args: Parameters<typeof OWNER.signTypedData>[0]) => {
          signatures++
          return OWNER.signTypedData(args)
        },
      },
    }
    await assert.rejects(seal(counting, 'bad//group'), { code: 'bad-group' })
    assert.equal(signatures, 0)
  })

  test('another wallet gets a message naming the owner and the group key', async () => {
    const { bytes } = await seal(owner)
    await fails(open(bytes, { owner: STRANGER }), 'not-owner')
    await assert.rejects(
      open(bytes, { owner: STRANGER }),
      new RegExp(
        `belongs to ${OWNER.address.toLowerCase()} under group key ${GROUP_KEY}`
      )
    )
  })

  test('no credentials, or Grants for another group key, are refused', async () => {
    const { bytes } = await seal(owner)
    await fails(open(bytes, undefined), 'no-credentials')
    const other = await session()
    if ('session' in other)
      other.session.grants = [
        await makeGrant({ groupKey: `0x${'ab'.repeat(16)}` }),
      ]
    if ('session' in other) other.session.groupKeyId = `0x${'ab'.repeat(16)}`
    await fails(open(bytes, other), 'not-owner')
  })

  test('a Grant for another session key, or one outside the piece group, opens nothing', async () => {
    const { bytes } = await seal(owner)
    await fails(
      open(bytes, await session(undefined, OTHER_SESSION_KEY)),
      'wrong-session-key'
    )
    await fails(open(bytes, await session('elsewhere')), 'no-grant-for-group')
  })

  test('a flipped ciphertext byte fails as a wrong key or a modified file', async () => {
    const { bytes } = await seal(owner)
    const tampered = bytes.slice()
    tampered[tampered.length - 100] = (tampered[tampered.length - 100] ?? 0) ^ 1
    await fails(open(tampered, owner), 'wrong-key-or-modified')
  })

  test('a truncated envelope fails as incomplete, even by one byte', async () => {
    const { bytes } = await seal(owner)
    await fails(open(bytes.slice(0, bytes.length - 1), owner), 'truncated')
    await fails(
      open(bytes.slice(0, bytes.length - CHUNK_SIZE - 16), owner),
      'truncated'
    )
  })

  test('the plaintext of a failed decryption is never released as complete', async () => {
    const { bytes } = await seal(owner)
    const stream = decrypt(
      streamOf(bytes.slice(0, bytes.length - 1)),
      ownerKeyResolver(OWNER)
    )
    await assert.rejects(collect(stream), { code: 'truncated' })
  })

  test('a sink failure cancels the download, keeps its code, and carries it as the cause', async () => {
    const { bytes } = await seal(owner)
    let pulled = 0
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= bytes.length) return controller.close()
        controller.enqueue(bytes.slice(pulled, pulled + 16 * 1024))
        pulled += 16 * 1024
      },
      cancel() {
        cancelled = true
      },
    })
    const full = Object.assign(new Error(`no space for ${SECRET}`), {
      code: 'ENOSPC',
    })
    await fails(
      decryptToSink(source, ownerKeyResolver(OWNER), {
        begin: () => {
          throw full
        },
        write: () => undefined,
      }).catch((error: unknown) => {
        assert.equal((error as Error).cause, full)
        assert.match((error as Error).message, /ENOSPC/)
        throw error
      }),
      'decrypt-failed'
    )
    assert.equal(cancelled, true)
    assert.ok(pulled < bytes.length, `pulled ${pulled} of ${bytes.length}`)
  })

  test('plain content is not an envelope', async () => {
    assert.equal(await isEnvelope(new TextEncoder().encode('hello')), false)
    assert.equal(await readEnvelopeHeader(new Uint8Array(0)), undefined)
    await fails(open(new TextEncoder().encode('hello'), owner), 'not-encrypted')
  })

  test('encrypt refuses a stream of another length than it committed to', async () => {
    const { input, source } = memoryInput(TREE)
    const plan = await planInnerCar(input, source)
    const sealed = await encrypt(emitInnerCar(plan, source), {
      credentials: owner,
      dataSets: [],
      contentLength: plan.contentLength + 1,
    })
    await assert.rejects(collect(sealed.envelope), { code: 'encrypt-failed' })
  })

  test("an owner-mode resolver reads an upload with no foc/own as the wallet's, as session mode does", async () => {
    const { labels } = await seal(owner)
    const { 'foc/own': _owner, ...unnamed } = labels
    const named = await ownerKeyResolver(OWNER)({
      appMetadata: labels,
    } as never)
    const key = await ownerKeyResolver(OWNER)({ appMetadata: unnamed } as never)
    assert.deepEqual(key, named)
    await assert.rejects(
      async () =>
        ownerKeyResolver(() => undefined)({ appMetadata: unnamed } as never),
      { code: 'no-credentials', message: /an unnamed owner/ }
    )
  })

  test('an owner-mode resolver given another owner names both', async () => {
    const { bytes } = await seal(owner)
    await assert.rejects(
      collect(decrypt(streamOf(bytes), ownerKeyResolver(STRANGER))),
      (error: unknown) =>
        error instanceof DecryptError && error.code === 'not-owner'
    )
    assert.ok(
      new NotOwnerError('0x1', '0x2', undefined).message.includes(
        'no credentials'
      )
    )
  })

  test('zeroes the key once the last plaintext byte is read, without another read', async () => {
    const { bytes, plan } = await seal(owner)
    let key: Uint8Array = new Uint8Array(0)
    const reader = decrypt(streamOf(bytes), async (info) => {
      const resolved = await ownerKeyResolver(OWNER)(info)
      key = resolved
      return resolved
    }).getReader()
    let read = 0
    while (read < plan.contentLength) {
      const { done, value } = await reader.read()
      assert.ok(!done)
      read += value.length
    }
    assert.equal(read, plan.contentLength)
    for (let i = 0; i < 200 && key.some((b) => b !== 0); i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(key.length > 0 && key.every((b) => b === 0))
  })

  test('surplus bytes after the envelope are wrong-key-or-modified, a cut one is truncated', async () => {
    const { bytes } = await seal(owner)
    const longer = new Uint8Array(bytes.length + 1)
    longer.set(bytes)
    await assert.rejects(
      collect(decrypt(streamOf(longer), ownerKeyResolver(OWNER))),
      { code: 'wrong-key-or-modified' }
    )
    await assert.rejects(
      collect(
        decrypt(streamOf(bytes.subarray(0, -1)), ownerKeyResolver(OWNER))
      ),
      { code: 'truncated' }
    )
  })

  test('decryptToSink refuses a bad limit as a RangeError before it asks for a key', async () => {
    const { bytes } = await seal(owner)
    for (const options of [
      { maxMetadataBytes: -1 },
      { maxVisits: -1 },
      { maxEntries: Number.NaN },
      { maxTotalPathBytes: 1.5 },
    ]) {
      let asked = 0
      await assert.rejects(
        decryptToSink(
          streamOf(bytes),
          () => {
            asked++
            return Promise.reject(new Error('unreachable'))
          },
          memorySink(),
          options
        ),
        RangeError
      )
      assert.equal(asked, 0)
    }
    let pulled = 0
    await assert.rejects(
      unpackInnerCar(
        (function* () {
          pulled++
          yield new Uint8Array(1)
        })(),
        memorySink(),
        { maxVisits: -1 }
      ),
      RangeError
    )
    assert.equal(pulled, 0)
  })

  test("a sink's error is decrypt-failed even when its text reads like Keysmith's", async () => {
    const { bytes } = await seal(owner)
    const denied = Object.assign(
      new Error(
        'EACCES: /keysmith 0.1.0 (format 1) data is not supported: a grant with v 1'
      ),
      { code: 'EACCES' }
    )
    const sink = {
      ...memorySink(),
      write() {
        throw denied
      },
    }
    await assert.rejects(
      decryptToSink(streamOf(bytes), ownerKeyResolver(OWNER), sink),
      (error: unknown) =>
        error instanceof DecryptError &&
        error.code === 'decrypt-failed' &&
        error.cause === denied
    )
  })

  test('a resolver called directly fails with a code, not the wallet error', async () => {
    const { bytes } = await seal(owner)
    const info = await fee.parse(bytes)
    const refusing = {
      address: OWNER.address,
      signTypedData: () =>
        Promise.reject(new Error(`User rejected: ${SECRET}`)),
    }
    await assert.rejects(
      async () => ownerKeyResolver(refusing as never)(info as never),
      (error: unknown) =>
        error instanceof DecryptError &&
        error.code === 'decrypt-failed' &&
        !error.message.includes(SECRET)
    )
  })

  test('zeroes a key the resolver returns after the stream was cancelled', async () => {
    const { bytes } = await seal(owner)
    const key = new Uint8Array(randomBytes(32))
    let release = (): void => undefined
    let asked = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reader = decrypt(streamOf(bytes), async () => {
      asked = true
      await gate
      return key
    }).getReader()
    const pending = reader.read().catch(() => undefined)
    for (let i = 0; i < 5000 && !asked; i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(asked)
    await reader.cancel()
    release()
    await pending
    for (let i = 0; i < 5000 && key.some((b) => b !== 0); i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(key.every((b) => b === 0))
  })

  test("a resolver's own error, such as a refused signature, is decrypt-failed with its cause", async () => {
    const { bytes } = await seal(owner)
    const refused = new Error('User rejected the request')
    const wallet = {
      address: OWNER.address,
      signTypedData: () => Promise.reject(refused),
    }
    await assert.rejects(
      decryptToSink(
        streamOf(bytes),
        ownerKeyResolver(wallet as never),
        memorySink()
      ),
      (error: unknown) =>
        error instanceof DecryptError &&
        error.code === 'decrypt-failed' &&
        error.cause === refused
    )
  })

  test("encrypt turns a wallet's or Keysmith's error into encrypt-failed with its cause", async () => {
    const { input, source } = memoryInput(TREE)
    const plan = await planInnerCar(input, source)
    const refused = new Error('User rejected the request')
    const wallet = {
      address: OWNER.address,
      signTypedData: () => Promise.reject(refused),
    }
    await assert.rejects(
      encryptPlan(plan, source, {
        credentials: { owner: wallet as never },
        dataSets: [],
      }),
      (error: unknown) =>
        error instanceof EncryptionError &&
        error.code === 'encrypt-failed' &&
        error.cause === refused
    )
    // A well-formed foc/kc that the owner's key doesn't match: Keysmith refuses after signing.
    const dataSets = [
      {
        dataSetId: 1n,
        metadata: {
          'foc/enc': '1',
          'foc/gkid': GROUP_KEY,
          'foc/kc': `v2.${'00'.repeat(16)}`,
        },
      },
    ]
    await assert.rejects(
      encryptPlan(plan, source, { credentials: owner, dataSets }),
      { name: 'EncryptionError', code: 'encrypt-failed' }
    )
  })

  test("keeps the code of this package's own errors, and a WebCrypto failure is decrypt-failed", async () => {
    const { bytes } = await seal(owner)
    const own = new EncryptionError('bad-group', 'Invalid group')
    await assert.rejects(
      collect(decrypt(streamOf(bytes), () => Promise.reject(own))),
      { name: 'DecryptError', code: 'bad-group', message: 'Invalid group' }
    )
    const crypto = new fee.errors.CryptoOperationError('decrypt failed')
    assert.equal(toDecryptError(crypto).code, 'decrypt-failed')
    assert.equal(toDecryptError(crypto).cause, crypto)
  })

  test('owner mode refuses a wallet address viem would refuse, before it signs, naming no value', async () => {
    const { input, source } = memoryInput(TREE)
    const plan = await planInnerCar(input, source)
    let signatures = 0
    const secret = `0x${'ab'.repeat(32)}`
    const dataSets = [
      {
        dataSetId: 1n,
        metadata: {
          'foc/enc': '1',
          'foc/gkid': GROUP_KEY,
          'foc/kc': `v2.${'11'.repeat(16)}`,
        },
      },
    ]
    for (const address of [
      secret,
      '0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266',
    ]) {
      const wallet = {
        address,
        signTypedData: (args: Parameters<typeof OWNER.signTypedData>[0]) => {
          signatures++
          return OWNER.signTypedData(args)
        },
      }
      for (const sets of [dataSets, []]) {
        await assert.rejects(
          encryptPlan(plan, source, {
            credentials: { owner: wallet as never },
            dataSets: sets,
          }),
          (error: unknown) =>
            error instanceof EncryptionError &&
            error.code === 'bad-address' &&
            !error.message.includes(address)
        )
      }
    }
    const { bytes } = await seal(owner)
    const badChecksum = {
      address: '0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266',
      signTypedData: () => {
        signatures++
        return Promise.reject(new Error('unreachable'))
      },
    }
    await assert.rejects(
      collect(decrypt(streamOf(bytes), ownerKeyResolver(badChecksum as never))),
      { name: 'DecryptError', code: 'bad-address' }
    )
    // Not the upload's owner either: the address is checked before a not-owner message could name it.
    const pasted = { ...badChecksum, address: secret }
    await assert.rejects(
      collect(decrypt(streamOf(bytes), ownerKeyResolver(pasted as never))),
      (error: unknown) =>
        error instanceof DecryptError &&
        error.code === 'bad-address' &&
        !error.message.includes(secret)
    )
    assert.equal(signatures, 0)
  })

  test('an error code copied into a message is only a code: a path or anything else gives the class name', () => {
    assert.equal(
      errorCode(Object.assign(new Error('x'), { code: 'ENOSPC' })),
      'ENOSPC'
    )
    assert.equal(
      errorCode(Object.assign(new Error('x'), { code: 'ERR_INVALID_STATE' })),
      'ERR_INVALID_STATE'
    )
    assert.equal(
      errorCode(Object.assign(new TypeError('x'), { code: '/private/secret' })),
      'TypeError'
    )
    assert.equal(errorCode({ code: 'has space', name: 'a/b' }), 'unknown error')
    for (const code of ['ABORT_ERR', 'EACCES', 'ERR_STREAM_PREMATURE_CLOSE'])
      assert.equal(errorCode({ code }), code)
    // A word could be a file name: only known system codes are copied.
    for (const code of ['payroll', 'PAYROLL', 'EPAYROLL', 'not-unixfs'])
      assert.equal(errorCode({ code }), 'unknown error')
    for (const name of ['AbortError', 'Error', 'InvalidAddressError'])
      assert.equal(errorCode({ name }), name)
    // An Access key, or another secret that fits a word's alphabet, is not a code.
    const key = `fak1_${'A'.repeat(43)}`
    for (const value of [key, key.toUpperCase(), 'fak1_AQID', 'A'.repeat(64)])
      assert.equal(errorCode({ code: value, name: value }), 'unknown error')
  })

  test('format-1 and bad-group messages repeat nothing a resolver or caller wrote', () => {
    const wrapped = new fee.errors.KeyResolutionError('resolver failed', {
      cause: new Error(
        `keysmith 0.1.0 (format 1) data is not supported: ${SECRET}`
      ),
    })
    const error = toDecryptError(wrapped)
    assert.equal(error.code, 'format-1')
    assert.ok(!error.message.includes(SECRET), error.message)
    assert.match(error.message, /format 1/)
    const subject = toDecryptError(
      new fee.errors.KeyResolutionError('resolver failed', {
        cause: new Error(
          'keysmith 0.1.0 (format 1) data is not supported: a payroll with v 1'
        ),
      })
    )
    assert.ok(!subject.message.includes('payroll'), subject.message)
    assert.throws(
      () => checkGroup(` ${SECRET}`),
      (thrown: unknown) =>
        thrown instanceof EncryptionError &&
        thrown.code === 'bad-group' &&
        !thrown.message.includes(SECRET)
    )
  })

  test('decrypt and decryptToSink refuse a locked stream as a DecryptError', async () => {
    const { bytes } = await seal(owner)
    const locked = streamOf(bytes)
    locked.getReader()
    assert.throws(() => decrypt(locked, ownerKeyResolver(OWNER)), {
      name: 'DecryptError',
      code: 'decrypt-failed',
    })
    await assert.rejects(
      decryptToSink(locked, ownerKeyResolver(OWNER), memorySink()),
      { name: 'DecryptError', code: 'decrypt-failed' }
    )
  })

  test('a FEE CAR with no Keysmith labels is an envelope, as in filecoin-pin, and decrypting it says why it fails', async () => {
    const pair = fee.encrypt({
      cek: new Uint8Array(randomBytes(32)),
      contentLength: 5,
      contentType: CAR_CONTENT_TYPE,
    })
    const bytes = await collect(streamOf(new Uint8Array(5)).pipeThrough(pair))
    assert.equal(await isEnvelope(bytes), true)
    assert.equal(await readEnvelopeHeader(bytes), undefined)
    await fails(open(bytes, owner), 'not-encrypted')
  })

  test('reads an envelope passed as one Uint8Array', async () => {
    const { bytes, plan } = await seal(owner)
    const plaintext = await collect(decrypt(bytes, ownerKeyResolver(OWNER)))
    assert.equal(plaintext.length, plan.contentLength)
  })
})

describe('Grant selection', () => {
  const sessionWith = (
    grants: string[],
    extra: { chainId?: number; now?: number } = {}
  ): Credentials => ({
    session: {
      sessionKey: SESSION_KEY,
      walletAddress: OWNER.address,
      groupKeyId: GROUP_KEY,
      grants,
      ...extra,
    },
  })

  test('with no chain id, considers the Grants of every network, in any order', async () => {
    const red = await makeGrant({ group: 'red', chainId: 314 })
    const blue = await makeGrant({ group: 'blue' })
    const { bytes } = await seal(
      sessionWith([blue], { chainId: CALIBRATION_CHAIN_ID }),
      'blue'
    )
    for (const grants of [
      [red, blue],
      [blue, red],
    ]) {
      const { sink } = await open(bytes, sessionWith(grants))
      assert.equal(sink.files.get(`${SECRET}/a.txt`)?.length, 5)
    }
  })

  test('picks Grants at the session time, not the clock', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    const old = await makeGrant({
      group: 'team',
      expires: past + 3600,
      now: past,
    })
    const then = sessionWith([old], {
      chainId: CALIBRATION_CHAIN_ID,
      now: past + 60,
    })
    const { bytes } = await seal(then, 'team')
    const { sink } = await open(bytes, then)
    assert.equal(sink.files.get(`${SECRET}/a.txt`)?.length, 5)
  })

  test('writes with the later of two Grants for one group, not as an ambiguous group', async () => {
    const credentials = sessionWith(
      [
        await makeGrant({ group: 'team', expires: FAR_FUTURE - 1000 }),
        await makeGrant({ group: 'team' }),
      ],
      { chainId: CALIBRATION_CHAIN_ID }
    )
    if (!('session' in credentials)) throw new Error('unreachable')
    const grants = await openSessionGrants(credentials.session)
    assert.equal(grantForWrite(grants, undefined).expires, FAR_FUTURE)
    for (const g of grants) g.key.fill(0)
  })

  test('a onIgnored that throws still fails the open, with the error it threw', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    const boom = new Error('listener failed')
    const credentials = sessionWith(
      [
        await makeGrant({ expires: past + 3600, now: past }),
        await makeGrant({}),
      ],
      { chainId: CALIBRATION_CHAIN_ID }
    )
    if (!('session' in credentials)) throw new Error('unreachable')
    await assert.rejects(
      openSessionGrants({
        ...credentials.session,
        onIgnored: () => {
          throw boom
        },
      }),
      (error: unknown) => error === boom
    )
  })
})

describe('envelope detection', () => {
  test('a one-shot FEE envelope around a CAR is an envelope, as in filecoin-pin, and decrypting it says why it fails', async () => {
    const bytes = await fee.aesGcm.encrypt(new Uint8Array(5), {
      cek: new Uint8Array(randomBytes(32)),
      contentType: CAR_CONTENT_TYPE,
    })
    assert.equal(await isEnvelope(bytes), true)
    assert.equal(await readEnvelopeHeader(bytes), undefined)
    await fails(open(bytes, owner), 'not-encrypted')
  })
})

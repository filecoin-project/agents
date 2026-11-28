import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decodeDelivery, encodeDelivery, publicKeyOf } from '@filoz/keysmith'
import { type Hex, recoverMessageAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EncryptionError, GrantError } from '../src/errors.ts'
import {
  GRANT_PREFIX,
  type GrantExpectations,
  type GrantLinkRequest,
  grantLinkParams,
  grantText,
  issueGrant,
  joinGrants,
  keyAgreementParams,
  openGrant,
  parseGrantLinkParams,
  precheckGrant,
  splitGrants,
  verifyKeyAgreementKey,
} from '../src/grant.ts'
import { fromBase64url } from '../src/internal/bytes.ts'
import { openSessionGrants } from '../src/keys.ts'
import {
  CALIBRATION_CHAIN_ID,
  FAR_FUTURE,
  GOLDEN_GRANT,
  GROUP_KEY,
  makeGrant,
  OTHER_SESSION_KEY,
  OWNER,
  PINNED_NOW,
  SESSION_ADDRESS,
  SESSION_KEY,
  STRANGER,
  STRANGER_KEY,
  V1_GRANT,
} from './fixtures/keys.ts'

const expected: GrantExpectations = {
  sessionKey: SESSION_KEY,
  walletAddress: OWNER.address,
  chainId: CALIBRATION_CHAIN_ID,
  now: PINNED_NOW,
}

/** Assert that opening `text` fails with `code`, and a message matching `message`. */
async function refuses(
  text: string | Promise<string>,
  code: string,
  message: RegExp,
  overrides: Partial<GrantExpectations> = {}
): Promise<void> {
  await assert.rejects(
    openGrant(await text, { ...expected, ...overrides }),
    (error: unknown) => {
      assert.ok(error instanceof GrantError, String(error))
      assert.equal(error.code, code)
      assert.match(error.message, message)
      return true
    }
  )
}

describe('openGrant', () => {
  test("opens filecoin-pin's golden Grant", async () => {
    const opened = await openGrant(GOLDEN_GRANT, {
      ...expected,
      groupKeyId: GROUP_KEY,
    })

    assert.deepEqual(opened, {
      text: GOLDEN_GRANT,
      groupKeyId: GROUP_KEY,
      owner: OWNER.address,
      chainId: BigInt(CALIBRATION_CHAIN_ID),
      expires: FAR_FUTURE,
      commitment: 'v2.a4c02bfbffcdbff74b3e6601a6746d9c',
    })
    assert.ok(!('key' in opened), 'the key never leaves the call')
  })

  test('strips every whitespace character, so a wrapped paste opens', async () => {
    const wrapped = `  ${GOLDEN_GRANT.slice(0, 100)}\n${GOLDEN_GRANT.slice(100, 300)}\r\n\t${GOLDEN_GRANT.slice(300)} \n`
    assert.equal((await openGrant(wrapped, expected)).text, GOLDEN_GRANT)
  })

  test('writes the delivery as fgr1_ and unpadded base64url', () => {
    assert.equal(grantText(new Uint8Array([0xfb, 0xff])), `${GRANT_PREFIX}-_8`)
  })

  test('names what was pasted instead of a Grant', async () => {
    await refuses(
      'fak1_c2VjcmV0',
      'access-key-pasted',
      /This is an Access key, not a Grant/
    )
    await refuses(
      'https://viewer.example/#v1/bafyabc',
      'share-link-pasted',
      /share link, not a Grant/
    )
    await refuses(
      'viewer.example/#v1/bafyabc',
      'share-link-pasted',
      /share link/
    )
    await refuses(
      GOLDEN_GRANT.slice(GRANT_PREFIX.length),
      'not-a-grant',
      /a Grant starts with fgr1_/
    )
    await refuses('', 'no-grant', /No Grant given/)
  })

  test('refuses a truncated Grant, and padded or standard-alphabet base64', async () => {
    await refuses(
      GOLDEN_GRANT.slice(0, 200),
      'incomplete',
      /incomplete or corrupted; copy it again/
    )
    // A body of 4k + 1 characters has no decoding: text cut there is incomplete too.
    for (const cut of [
      `${GRANT_PREFIX}A`,
      GOLDEN_GRANT.slice(0, GRANT_PREFIX.length + 201),
    ])
      await refuses(cut, 'incomplete', /incomplete or corrupted/)
    await refuses(
      `${GOLDEN_GRANT}==`,
      'not-a-grant',
      /characters a Grant never has/
    )
    const body = GOLDEN_GRANT.slice(GRANT_PREFIX.length)
      .replaceAll('-', '+')
      .replaceAll('_', '/')
    await refuses(
      `${GRANT_PREFIX}${body}`,
      'not-a-grant',
      /characters a Grant never has/
    )
  })

  test('refuses a tampered Grant: the signature no longer verifies', async () => {
    const bytes =
      fromBase64url(GOLDEN_GRANT.slice(GRANT_PREFIX.length)) ?? new Uint8Array()
    const { chain, grant } = decodeDelivery(bytes)
    const tampered = grantText(
      encodeDelivery({ ...chain, expires: chain.expires - 1 }, grant)
    )
    await refuses(
      tampered,
      'does-not-verify',
      /does not verify .*copy it again/
    )
  })

  test('refuses a Grant for another session key, naming both', async () => {
    const other = privateKeyToAccount(OTHER_SESSION_KEY).address
    await refuses(
      GOLDEN_GRANT,
      'wrong-session-key',
      new RegExp(
        `another session key \\(${SESSION_ADDRESS}\\), not this one \\(${other}\\)`
      ),
      { sessionKey: OTHER_SESSION_KEY }
    )
    await refuses(
      makeGrant({ sessionKey: OTHER_SESSION_KEY }),
      'wrong-session-key',
      /another session key/
    )
  })

  test('refuses an expired Grant', async () => {
    await refuses(
      makeGrant({ expires: PINNED_NOW - 1 }),
      'expired',
      /expired at 2025-12-31T23:59:59\.000Z/
    )
    await refuses(GOLDEN_GRANT, 'expired', /expired/, { now: FAR_FUTURE })
    // Past the last date a JavaScript Date holds, the expiry is given in Unix seconds.
    const late = 8_640_000_000_001
    await refuses(
      makeGrant({ expires: late }),
      'expired',
      /expired at Unix second 8640000000001/,
      { now: late + 1 }
    )
  })

  test('refuses a Grant from another owner', async () => {
    await refuses(
      GOLDEN_GRANT,
      'wrong-owner',
      new RegExp(`from wallet ${OWNER.address}, not ${STRANGER.address}`),
      {
        walletAddress: STRANGER.address,
      }
    )
    await refuses(
      makeGrant({ ownerKey: STRANGER_KEY }),
      'wrong-owner',
      /from wallet/
    )
  })

  test('refuse a malformed session key, wallet address, or chain id with a code, naming none of them', async () => {
    const pasted = `0x${'ab'.repeat(32)}`
    await assert.rejects(
      openGrant(GOLDEN_GRANT, { ...expected, walletAddress: pasted }),
      (error: unknown) =>
        error instanceof EncryptionError &&
        error.code === 'bad-address' &&
        !error.message.includes(pasted)
    )
    for (const chainId of [1.5, 0, -1n, 2 ** 53])
      await assert.rejects(openGrant(GOLDEN_GRANT, { ...expected, chainId }), {
        name: 'GrantError',
        code: 'bad-chain-id',
      })
    // A saved group key id that is something else, such as a pasted key.
    await assert.rejects(
      openGrant(GOLDEN_GRANT, { ...expected, groupKeyId: pasted }),
      (error: unknown) =>
        error instanceof GrantError &&
        error.code === 'bad-group-key' &&
        !error.message.includes(pasted)
    )
    for (const now of [Number.NaN, 1.5, -1])
      await assert.rejects(openGrant(GOLDEN_GRANT, { ...expected, now }), {
        name: 'RangeError',
      })
    // viem drops the first two characters of a key, whatever they are.
    const unprefixed = `xx${SESSION_KEY.slice(2)}` as Hex
    for (const sessionKey of [
      '0x1234',
      `0x${'00'.repeat(32)}`,
      unprefixed,
    ] as const) {
      const refused = (error: unknown): boolean =>
        error instanceof GrantError &&
        error.code === 'bad-session-key' &&
        !error.message.includes(sessionKey)
      await assert.rejects(
        openGrant(GOLDEN_GRANT, { ...expected, sessionKey }),
        refused
      )
      assert.throws(
        () => precheckGrant(GOLDEN_GRANT, sessionKey, PINNED_NOW),
        refused
      )
      // The key is checked before the text is decoded.
      assert.throws(
        () => precheckGrant('not a grant', sessionKey, PINNED_NOW),
        refused
      )
      await assert.rejects(keyAgreementParams(sessionKey), refused)
      // A session's own mistake is reported once, not once per Grant.
      await assert.rejects(
        openSessionGrants({
          sessionKey,
          walletAddress: OWNER.address,
          groupKeyId: GROUP_KEY,
          grants: [GOLDEN_GRANT, GOLDEN_GRANT],
        }),
        (error: unknown) =>
          refused(error) &&
          error instanceof Error &&
          error.message.split('secp256k1').length === 2
      )
    }
  })

  test('refuses a Grant for another network', async () => {
    await refuses(
      GOLDEN_GRANT,
      'wrong-network',
      /another network \(chain id 314159, not 314\)/,
      { chainId: 314 }
    )
    await refuses(
      makeGrant({ chainId: 314 }),
      'wrong-network',
      /chain id 314, not 314159/
    )
  })

  test('refuses a Grant for another group key than the saved one', async () => {
    const other = `0x${'ab'.repeat(16)}`
    await refuses(
      GOLDEN_GRANT,
      'wrong-group-key',
      new RegExp(`group key ${GROUP_KEY}, but the saved group key is ${other}`),
      {
        groupKeyId: other,
      }
    )
  })

  test('opens a Grant for a group, not only the whole group key', async () => {
    const opened = await openGrant(await makeGrant({ group: 'team' }), {
      ...expected,
      now: undefined,
    })
    assert.equal(opened.group, 'team')
  })

  test('refuses a format 1 Grant as such, not as corrupted', async () => {
    await refuses(
      V1_GRANT,
      'format-1',
      /keysmith 0\.1\.0 \(format 1\).* Get a new Grant/
    )
  })

  test('precheck catches the session key and the expiry without the network', () => {
    assert.throws(
      () => precheckGrant(GOLDEN_GRANT, OTHER_SESSION_KEY, PINNED_NOW),
      /another session key/
    )
    assert.throws(
      () => precheckGrant(GOLDEN_GRANT, SESSION_KEY, FAR_FUTURE),
      /expired/
    )
    precheckGrant(GOLDEN_GRANT, SESSION_KEY, PINNED_NOW)
  })
})

describe('stored Grants', () => {
  test('join with commas and split back, dropping whitespace and empty entries', () => {
    assert.equal(joinGrants(['fgr1_a', 'fgr1_b']), 'fgr1_a,fgr1_b')
    assert.deepEqual(splitGrants(' fgr1_a ,\n,fgr1_\nb,'), ['fgr1_a', 'fgr1_b'])
  })
})

describe('the console link contract', () => {
  test("keyAgreementParams is the session key's public key, signed by the session key", async () => {
    const { pubkey, pubkeysig } = await keyAgreementParams(SESSION_KEY)

    assert.equal(pubkey, publicKeyOf(SESSION_KEY).toLowerCase())
    assert.match(pubkey, /^0x04[0-9a-f]{128}$/)
    assert.match(pubkeysig, /^0x[0-9a-f]{130}$/)
    const signer = await recoverMessageAddress({
      message: `Keysmith key agreement key: ${pubkey}`,
      signature: pubkeysig,
    })
    assert.equal(signer, SESSION_ADDRESS)
    assert.equal(
      await verifyKeyAgreementKey(SESSION_ADDRESS, { pubkey, pubkeysig }),
      true
    )
    assert.equal(
      await verifyKeyAgreementKey(STRANGER.address, { pubkey, pubkeysig }),
      false
    )
  })

  test('grantLinkParams names the node and maxdepth as the console reads them', async () => {
    const whole = await grantLinkParams({ sessionKey: SESSION_KEY })
    assert.deepEqual(Object.keys(whole), [
      'pubkey',
      'pubkeysig',
      'node',
      'maxdepth',
    ])
    assert.equal(whole.node, 'groupKey')
    // Always written, so the console's default of 7 never applies.
    assert.equal(whole.maxdepth, '0')
    const group = await grantLinkParams({
      sessionKey: SESSION_KEY,
      group: 'finance/clerks',
      maxDepth: 0,
    })
    assert.equal(group.node, 'group:finance/clerks')
    assert.equal(group.maxdepth, '0')
    await assert.rejects(
      grantLinkParams({ sessionKey: SESSION_KEY, maxDepth: 8 }),
      { code: 'bad-maxdepth' }
    )
    await assert.rejects(
      grantLinkParams({ sessionKey: SESSION_KEY, group: 'a//b' }),
      { code: 'bad-group' }
    )
  })

  test('issueGrant refuses a key-agreement key the bearer did not sign', async () => {
    const { pubkey, pubkeysig } = await keyAgreementParams(OTHER_SESSION_KEY)
    await assert.rejects(
      issueGrant({
        owner: OWNER,
        groupKeyId: GROUP_KEY,
        chainId: CALIBRATION_CHAIN_ID,
        bearer: SESSION_ADDRESS,
        pubkey,
        pubkeysig,
        expires: FAR_FUTURE,
      }),
      { code: 'bad-pubkeysig' }
    )
  })

  test('issueGrant refuses a malformed key-agreement key or expiry before the wallet signs', async () => {
    const { pubkey, pubkeysig } = await keyAgreementParams(SESSION_KEY)
    let signatures = 0
    const owner = {
      address: OWNER.address,
      signTypedData: (args: Parameters<typeof OWNER.signTypedData>[0]) => {
        signatures++
        return OWNER.signTypedData(args)
      },
    }
    const base = {
      owner,
      groupKeyId: GROUP_KEY,
      chainId: CALIBRATION_CHAIN_ID,
      bearer: SESSION_ADDRESS,
      pubkeysig,
      expires: FAR_FUTURE,
    }
    // x = 0 has no point on secp256k1; the second is not uncompressed at all.
    for (const bad of [`0x04${'00'.repeat(64)}`, pubkey.slice(0, 68)]) {
      await assert.rejects(issueGrant({ ...base, pubkey: bad as never }), {
        code: 'bad-pubkey',
      })
    }
    await assert.rejects(issueGrant({ ...base, pubkey, expires: 1.5 }), {
      code: 'bad-expires',
    })
    const past = Math.floor(Date.now() / 1000) - 60
    await assert.rejects(issueGrant({ ...base, pubkey, expires: past }), {
      code: 'bad-expires',
    })
    await assert.rejects(
      issueGrant({ ...base, pubkey, groupKeyId: '0x1234' as never }),
      { code: 'bad-group-key' }
    )
    // Keysmith would sign a chain id past 2^53 and then refuse to read it back.
    for (const chainId of [9007199254740993n, 0, 1.5])
      await assert.rejects(issueGrant({ ...base, pubkey, chainId }), {
        code: 'bad-chain-id',
      })
    // The last: mixed case with a wrong EIP-55 checksum, which viem refuses once the wallet has signed.
    for (const address of [
      // A private key pasted where an address goes: the message must not repeat it.
      `0x${'ab'.repeat(32)}`,
      '0xnotanaddress',
      '0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266',
    ]) {
      const named = (error: unknown): boolean =>
        error instanceof EncryptionError &&
        error.code === 'bad-address' &&
        !error.message.includes(address)
      await assert.rejects(
        issueGrant({ ...base, pubkey, owner: { ...owner, address } as never }),
        named
      )
      await assert.rejects(
        issueGrant({ ...base, pubkey, bearer: address as never }),
        named
      )
    }
    for (const [commitment, code] of [
      [`v1.${'11'.repeat(16)}`, 'format-1'],
      ['v2.b', 'bad-commitment'],
    ] as const)
      await assert.rejects(issueGrant({ ...base, pubkey, commitment }), {
        code,
      })
    assert.equal(signatures, 0)
  })

  test("issueGrant turns a wallet's or Keysmith's error into issue-failed with its cause", async () => {
    const { pubkey, pubkeysig } = await keyAgreementParams(SESSION_KEY)
    const refused = new Error('User rejected the request')
    const base = {
      groupKeyId: GROUP_KEY,
      chainId: CALIBRATION_CHAIN_ID,
      bearer: SESSION_ADDRESS,
      pubkey,
      pubkeysig,
      expires: FAR_FUTURE,
    }
    await assert.rejects(
      issueGrant({
        ...base,
        owner: {
          address: OWNER.address,
          signTypedData: () => Promise.reject(refused),
        },
      }),
      (error: unknown) =>
        error instanceof EncryptionError &&
        error.code === 'issue-failed' &&
        error.cause === refused
    )
    // A well-formed commitment the owner's key doesn't match.
    await assert.rejects(
      issueGrant({
        ...base,
        owner: OWNER,
        commitment: `v2.${'00'.repeat(16)}`,
      }),
      { name: 'EncryptionError', code: 'issue-failed' }
    )
  })

  test('parseGrantLinkParams reads what grantLinkParams writes', async () => {
    const written = await grantLinkParams({
      sessionKey: SESSION_KEY,
      group: 'finance/clerks',
      maxDepth: 2,
    })
    const read = parseGrantLinkParams(new URLSearchParams(written))
    assert.deepEqual(read, {
      pubkey: written.pubkey,
      pubkeysig: written.pubkeysig,
      group: 'finance/clerks',
      maxDepth: 2,
    })
    assert.equal(
      await verifyKeyAgreementKey(SESSION_ADDRESS, read as GrantLinkRequest),
      true
    )
    assert.equal(
      parseGrantLinkParams(new URLSearchParams('network=x')),
      undefined
    )
    const { maxdepth: _, ...noDepth } = written
    assert.equal(
      parseGrantLinkParams(new URLSearchParams(noDepth))?.maxDepth,
      0
    )
  })

  test('parseGrantLinkParams refuses what the console refuses', async () => {
    const good = await grantLinkParams({ sessionKey: SESSION_KEY })
    const refuses = (change: Record<string, string>, code: string) =>
      assert.throws(
        () => parseGrantLinkParams(new URLSearchParams({ ...good, ...change })),
        (error: unknown) => error instanceof GrantError && error.code === code
      )
    refuses({ pubkey: '0x02' }, 'bad-pubkey')
    refuses({ pubkeysig: '0x12' }, 'bad-pubkeysig')
    refuses({ node: 'keyspace' }, 'old-cli')
    refuses({ node: 'scope:a' }, 'old-cli')
    refuses({ node: 'group:a//b' }, 'bad-group')
    refuses({ node: 'piece:x' }, 'bad-node')
    for (const depth of ['8', '07', '7.0', ' 7', ''])
      refuses({ maxdepth: depth }, 'bad-maxdepth')
  })

  test('issueGrant takes a bigint expiry and a null commitment, as the console passes them', async () => {
    const { pubkey, pubkeysig } = await keyAgreementParams(SESSION_KEY)
    const text = await issueGrant({
      owner: OWNER,
      groupKeyId: GROUP_KEY,
      commitment: null,
      chainId: CALIBRATION_CHAIN_ID,
      bearer: SESSION_ADDRESS,
      pubkey,
      pubkeysig,
      expires: BigInt(FAR_FUTURE),
    })
    const info = await openGrant(text, {
      sessionKey: SESSION_KEY,
      walletAddress: OWNER.address,
      chainId: CALIBRATION_CHAIN_ID,
    })
    assert.equal(info.expires, FAR_FUTURE)
    await assert.rejects(
      issueGrant({
        owner: OWNER,
        groupKeyId: GROUP_KEY,
        chainId: CALIBRATION_CHAIN_ID,
        bearer: SESSION_ADDRESS,
        pubkey,
        pubkeysig,
        expires: FAR_FUTURE,
        maxDepth: 8,
      }),
      { code: 'bad-maxdepth' }
    )
  })
})

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  decodeDelivery,
  delegateClaim,
  deriveGroupKey,
  encodeDelivery,
  encodeGrant,
  grantDescriptor,
  keyForEnvelope,
  newSalt,
  openDelivery,
  type PieceMetadata,
  pieceMetadata,
  pieceNode,
  publicKeyOf,
  rootClaim,
  wrapTo,
} from '@filoz/keysmith'
import { CID } from 'multiformats/cid'
import { bytesToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Credentials } from '../src/envelope.ts'
import { EncryptionError, ShareLinkError } from '../src/errors.ts'
import { decodeGrantText } from '../src/grant.ts'
import {
  accessKeyText,
  createShare,
  formatShareLink,
  parseAccessKey,
  parseShareLink,
  shareKey,
  shareKeyResolver,
  shareOwner,
} from '../src/share.ts'
import {
  CALIBRATION_CHAIN_ID,
  FAR_FUTURE,
  GOLDEN_GRANT,
  GROUP_KEY,
  makeGrant,
  OWNER,
  SESSION_KEY,
  STRANGER,
} from './fixtures/keys.ts'
import { fixture } from './helpers.ts'

const ROOT = CID.parse(
  'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
)
const VIEWER = 'https://viewer.test/'

/** filecoin-pin's pinned share links; see fixtures/filecoin-pin/NOTICE.md. */
const vectors = JSON.parse(
  new TextDecoder().decode(await fixture('share-link-vectors.json'))
) as {
  labels: PieceMetadata
  pieceKey: Hex
  opening: { name: string; link: string; accessKey?: string }[]
}

const labelsFor = (group?: string): PieceMetadata =>
  pieceMetadata(
    { owner: OWNER.address, groupKeyId: GROUP_KEY },
    { salt: newSalt(), ...(group != null && { group }) }
  )

/** The upload's key as the owner derives it: what every share must open to. */
async function ownerPieceKey(labels: PieceMetadata): Promise<Hex> {
  const { groupKey } = await deriveGroupKey(OWNER, {
    owner: OWNER.address,
    groupKeyId: GROUP_KEY,
  })
  return bytesToHex(keyForEnvelope(groupKey, labels))
}

/** Open a link as a recipient would, and return the key it gives for `labels`. */
async function openLink(
  link: string,
  accessKey: string | undefined,
  labels: PieceMetadata
): Promise<Hex> {
  const parsed = parseShareLink(link)
  return bytesToHex(
    await shareKeyResolver(
      parsed,
      shareKey(parsed, accessKey)
    )({ appMetadata: labels } as never)
  )
}

const session = async (group?: string): Promise<Credentials> => ({
  session: {
    sessionKey: SESSION_KEY,
    walletAddress: OWNER.address,
    chainId: CALIBRATION_CHAIN_ID,
    groupKeyId: GROUP_KEY,
    grants: [group == null ? GOLDEN_GRANT : await makeGrant({ group })],
  },
})

describe('pinned share links', () => {
  // Expected values computed independently in filecoin-pin's tests.
  const PAYLOAD = new Uint8Array([0x83, 1, 2, 3])
  const KEY = bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
  const FRAGMENT = `${VIEWER}#v1/${ROOT}&d=gwECAw`

  test('formats and parses both link forms exactly', () => {
    for (const [accessKey, link] of [
      [undefined, FRAGMENT],
      [KEY, `${FRAGMENT}&k=fak1_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA`],
    ] as const) {
      assert.equal(formatShareLink(VIEWER, ROOT, PAYLOAD, accessKey), link)
      const parsed = parseShareLink(link)
      assert.ok(parsed.rootCid.equals(ROOT))
      assert.deepEqual(parsed.payload, PAYLOAD)
      assert.equal(parsed.accessKey, accessKey)
    }
  })

  test("the vector labels derive filecoin-pin's pinned piece key", async () => {
    assert.equal(await ownerPieceKey(vectors.labels), vectors.pieceKey)
  })

  for (const vector of vectors.opening) {
    test(`"${vector.name}" opens to the pinned piece key`, async () => {
      assert.equal(
        await openLink(vector.link, vector.accessKey, vectors.labels),
        vectors.pieceKey
      )
      const parsed = parseShareLink(vector.link)
      assert.equal(
        await shareOwner(parsed, shareKey(parsed, vector.accessKey)),
        OWNER.address
      )
    })
  }
})

describe('createShare', () => {
  for (const [who, sender] of [
    ['the owner', async () => ({ owner: OWNER }) as Credentials],
    ['a session key', () => session()],
  ] as const) {
    for (const mode of ['open', 'restricted'] as const) {
      test(`${who} makes an ${mode} link that opens to the upload's key`, async () => {
        const labels = labelsFor()
        const share = await createShare({
          sender: await sender(),
          rootCid: ROOT,
          labels,
          mode,
          viewer: VIEWER,
        })
        assert.ok(share.link.startsWith(`${VIEWER}#v1/${ROOT}&d=`))
        assert.equal(share.link.includes('&k=fak1_'), mode === 'open')
        assert.equal(share.accessKey != null, mode === 'restricted')
        assert.equal(
          await openLink(share.link, share.accessKey, labels),
          await ownerPieceKey(labels)
        )
      })
    }
  }

  test('a session key shares only uploads a Grant reaches', async () => {
    await assert.rejects(
      createShare({
        sender: await session('team'),
        rootCid: ROOT,
        labels: labelsFor('other'),
        mode: 'open',
      }),
      { code: 'no-grant-for-group' }
    )
    const share = await createShare({
      sender: await session('team'),
      rootCid: ROOT,
      labels: labelsFor('team/x'),
      mode: 'open',
    })
    assert.ok(share.link.startsWith('https://viewer.filecoin.cloud/#v1/'))
  })

  test('the owner shares an upload with no foc/own, as filecoin-pin does', async () => {
    const labels = labelsFor()
    const { 'foc/own': _owner, ...unnamed } = labels
    const share = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels: unnamed as never,
      mode: 'open',
      viewer: VIEWER,
    })
    assert.equal(
      await openLink(share.link, undefined, labels),
      await ownerPieceKey(labels)
    )
  })

  test("a wallet's own error is share-failed with its cause, and a bad address is refused before signing", async () => {
    const refused = new Error('User rejected the request')
    await assert.rejects(
      createShare({
        sender: {
          owner: {
            address: OWNER.address,
            signTypedData: () => Promise.reject(refused),
          },
        },
        rootCid: ROOT,
        labels: labelsFor(),
        mode: 'open',
      }),
      (error: unknown) =>
        error instanceof EncryptionError &&
        error.code === 'share-failed' &&
        error.cause === refused
    )
    let signatures = 0
    const { 'foc/own': _owner, ...unnamed } = labelsFor()
    await assert.rejects(
      createShare({
        sender: {
          owner: {
            address: '0xnotanaddress' as never,
            signTypedData: () => {
              signatures++
              return Promise.reject(refused)
            },
          },
        },
        rootCid: ROOT,
        labels: unnamed as never,
        mode: 'open',
      }),
      { code: 'bad-address' }
    )
    assert.equal(signatures, 0)
  })

  test('another wallet cannot share the upload', async () => {
    await assert.rejects(
      createShare({
        sender: { owner: STRANGER },
        rootCid: ROOT,
        labels: labelsFor(),
        mode: 'open',
      }),
      {
        code: 'not-owner',
      }
    )
  })

  test('a share opens only its own upload, and only with its own Access key', async () => {
    const labels = labelsFor()
    const { link, accessKey } = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'restricted',
    })
    await assert.rejects(openLink(link, accessKey, labelsFor()), {
      code: 'other-upload',
    })
    await assert.rejects(
      openLink(link, accessKeyText(generatePrivateKey()), labels),
      { code: 'wrong-access-key' }
    )
    assert.throws(() => shareKey(parseShareLink(link), undefined), {
      code: 'needs-access-key',
    })
  })
})

describe('share link text', () => {
  const link = formatShareLink(VIEWER, ROOT, new Uint8Array([0x83]))

  test('refuses a wrong paste with a specific error', () => {
    const refuses = (fn: () => unknown, code: string) =>
      assert.throws(
        fn,
        (error: unknown) =>
          error instanceof ShareLinkError && error.code === code
      )
    refuses(() => parseShareLink('fak1_AQID'), 'access-key-pasted')
    refuses(() => parseShareLink(GOLDEN_GRANT), 'grant-pasted')
    refuses(
      () => parseShareLink('https://viewer.test/#v2/x'),
      'not-a-share-link'
    )
    refuses(() => parseShareLink(`${VIEWER}#v1/nope&d=gw`), 'bad-cid')
    refuses(() => parseShareLink(`${link}&x=1`), 'bad-part')
    refuses(() => parseShareLink(`${link}&d=gw`), 'bad-part')
    refuses(() => parseShareLink(`${VIEWER}#v1/${ROOT}`), 'incomplete')
    refuses(() => parseShareLink(`${VIEWER}#v1/${ROOT}&d=a+b`), 'bad-part')
    refuses(() => parseAccessKey(link), 'share-link-pasted')
    refuses(() => parseAccessKey(GOLDEN_GRANT), 'grant-pasted')
    refuses(() => parseAccessKey('nope'), 'not-an-access-key')
    refuses(() => parseAccessKey('fak1_AQID'), 'incomplete')
  })

  test('accessKeyText refuses what parseAccessKey refuses, naming no value', () => {
    for (const key of [
      '0xzz',
      '0x01',
      `0x${'00'.repeat(32)}`,
      `xx${'11'.repeat(32)}`,
    ])
      assert.throws(
        () => accessKeyText(key as Hex),
        (error: unknown) =>
          error instanceof ShareLinkError &&
          error.code === 'wrong-access-key' &&
          !error.message.includes(key.slice(2, 8))
      )
  })

  test('never echoes a malformed part, which may be an Access key', () => {
    const key = accessKeyText(generatePrivateKey())
    const mangled = `${link}&k${key}`
    assert.throws(
      () => parseShareLink(mangled),
      (error: unknown) =>
        error instanceof ShareLinkError &&
        error.code === 'bad-part' &&
        !error.message.includes(key.slice(5, 20))
    )
  })

  test('strips whitespace from a wrapped paste', () => {
    const key = generatePrivateKey()
    const open = formatShareLink(VIEWER, ROOT, new Uint8Array([1, 2]), key)
    assert.equal(
      parseShareLink(` ${open.slice(0, 30)}\n${open.slice(30)} `).accessKey,
      key
    )
    assert.equal(parseAccessKey(` ${accessKeyText(key)}\n`), key)
  })
})

describe('the viewer grammar', () => {
  const link = formatShareLink(VIEWER, ROOT, new Uint8Array([0x83]))
  const refuses = (text: string, code: string) =>
    assert.throws(
      () => parseShareLink(text),
      (error: unknown) => error instanceof ShareLinkError && error.code === code
    )

  test('writes only links it reads back', () => {
    const v0 = formatShareLink(VIEWER, ROOT.toV0(), new Uint8Array([0x83]))
    assert.ok(parseShareLink(v0).rootCid.equals(ROOT))
    assert.throws(
      () => formatShareLink(VIEWER, ROOT, new Uint8Array(6145)),
      (error: unknown) =>
        error instanceof ShareLinkError && error.code === 'bad-part'
    )
    const fails = (fn: () => unknown, code: string) =>
      assert.throws(
        fn,
        (error: unknown) =>
          error instanceof ShareLinkError && error.code === code
      )
    fails(() => formatShareLink(VIEWER, ROOT, new Uint8Array(0)), 'bad-part')
    const bytes = new Uint8Array([0x83])
    fails(
      () => formatShareLink(VIEWER, ROOT, bytes, '0x1234'),
      'wrong-access-key'
    )
    // Zero is 32 bytes but not a secp256k1 private key.
    const zero = `0x${'00'.repeat(32)}` as Hex
    fails(() => formatShareLink(VIEWER, ROOT, bytes, zero), 'wrong-access-key')
  })

  test('refuses what the viewer refuses', () => {
    const key = generatePrivateKey()
    const open = formatShareLink(VIEWER, ROOT, new Uint8Array([0x83]), key)
    const [base, fragment] = open.split('#') as [string, string]
    const [cid, d, k] = fragment.split('&')
    refuses(`${base}#${cid}&${k}&${d}`, 'bad-part')
    refuses(`${VIEWER}#v1/${ROOT.toV0()}&d=gw`, 'bad-cid')
    refuses(`${VIEWER}#v1/${ROOT.toString().toUpperCase()}&d=gw`, 'bad-cid')
    // `gx` decodes to the same byte as `gw`, with stray bits.
    refuses(`${VIEWER}#v1/${ROOT}&d=gx`, 'bad-part')
    refuses(`${VIEWER}#v1/${ROOT}&d=${'A'.repeat(8193)}`, 'bad-part')
    refuses(`${link}&k=fak1_${'A'.repeat(43)}`, 'wrong-access-key')
    assert.equal(parseShareLink(open).accessKey, key)
  })
})

describe('Delivery shares', () => {
  /** A share whose payload is a Delivery: a root claim from the owner to T for one piece. */
  async function deliveryShare(
    labels: PieceMetadata,
    options: { expires: number; now?: number; bearer?: Hex }
  ) {
    const T = generatePrivateKey()
    const bearer = privateKeyToAccount(options.bearer ?? T).address
    const ref = { owner: OWNER.address, groupKeyId: GROUP_KEY }
    const { groupKey } = await deriveGroupKey(OWNER, ref)
    const node = pieceNode(labels)
    const { chain, nodeKey } = await rootClaim(OWNER, {
      ...ref,
      chainId: BigInt(CALIBRATION_CHAIN_ID),
      groupKey,
      node,
      bearer,
      maxDepth: 0,
      expires: options.expires,
      piece: labels,
      ...(options.now != null && { now: options.now }),
    })
    const grant = await wrapTo(
      publicKeyOf(T),
      nodeKey,
      grantDescriptor(ref, node)
    )
    return { payload: encodeDelivery(chain, grant), T }
  }

  test('opens a Delivery share to the upload key, and names its owner', async () => {
    const labels = labelsFor()
    const { payload, T } = await deliveryShare(labels, {
      expires: FAR_FUTURE,
    })
    const link = formatShareLink(VIEWER, ROOT, payload, T)
    assert.equal(
      await openLink(link, undefined, labels),
      await ownerPieceKey(labels)
    )
    assert.equal(await shareOwner(parseShareLink(link), T), OWNER.address)
  })

  test('refuses an expired, misdirected, or tampered Delivery', async () => {
    const labels = labelsFor()
    const fails = async (link: string, code: string) =>
      assert.rejects(openLink(link, undefined, labels), { code })

    const past = Math.floor(Date.now() / 1000) - 3600
    const expired = await deliveryShare(labels, {
      expires: past + 60,
      now: past,
    })
    await fails(
      formatShareLink(VIEWER, ROOT, expired.payload, expired.T),
      'share-expired'
    )

    const other = await deliveryShare(labels, {
      expires: FAR_FUTURE,
      bearer: generatePrivateKey(),
    })
    await fails(
      formatShareLink(VIEWER, ROOT, other.payload, other.T),
      'wrong-access-key'
    )

    const good = await deliveryShare(labels, { expires: FAR_FUTURE })
    const { chain, grant } = decodeDelivery(good.payload)
    const root = chain.links[0]
    assert.ok(root != null)
    const forged = encodeDelivery(
      { ...chain, links: [{ ...root, maxDepth: 3 }] },
      grant
    )
    await fails(formatShareLink(VIEWER, ROOT, forged, good.T), 'damaged-link')
  })

  test('refuses a payload that is no Grant, or one for a whole group key', async () => {
    const labels = labelsFor()
    const T = generatePrivateKey()
    await assert.rejects(
      openLink(
        formatShareLink(VIEWER, ROOT, new Uint8Array([1, 2]), T),
        undefined,
        labels
      ),
      { code: 'damaged-link' }
    )
    const ref = { owner: OWNER.address, groupKeyId: GROUP_KEY }
    const { groupKey } = await deriveGroupKey(OWNER, ref)
    const wide = encodeGrant(
      await wrapTo(publicKeyOf(T), groupKey, grantDescriptor(ref, 'groupKey'))
    )
    await assert.rejects(
      openLink(formatShareLink(VIEWER, ROOT, wide, T), undefined, labels),
      { code: 'damaged-link' }
    )
    // Keysmith's decodeGrant reads any node text: a piece node with no salt is damaged, not the wrong key.
    const text = (s: string) => [
      0x60 + s.length,
      ...new TextEncoder().encode(s),
    ]
    const from = [0x01, ...text('groupKey')]
    const at = wide.findIndex((_, i) => from.every((b, j) => wide[i + j] === b))
    assert.ok(at > 0)
    const malformed = new Uint8Array([
      ...wide.subarray(0, at),
      0x01,
      ...text('piece:not-a-salt'),
      ...wide.subarray(at + from.length),
    ])
    await assert.rejects(
      openLink(formatShareLink(VIEWER, ROOT, malformed, T), undefined, labels),
      { code: 'damaged-link' }
    )
  })

  test('opens a Delivery that a group Grant narrowed to the piece, and refuses it for another upload', async () => {
    const labels = labelsFor('team')
    const { bytes } = decodeGrantText(
      await makeGrant({ group: 'team', maxDepth: 1 })
    )
    const held = await openDelivery(SESSION_KEY, bytes)
    const T = generatePrivateKey()
    const node = pieceNode(labels)
    const { chain, nodeKey } = await delegateClaim(
      privateKeyToAccount(SESSION_KEY),
      held.chain,
      {
        parentKey: held.key,
        node,
        bearer: privateKeyToAccount(T).address,
        maxDepth: 0,
        piece: labels,
      }
    )
    const grant = await wrapTo(
      publicKeyOf(T),
      nodeKey,
      grantDescriptor({ owner: OWNER.address, groupKeyId: GROUP_KEY }, node)
    )
    const link = formatShareLink(VIEWER, ROOT, encodeDelivery(chain, grant), T)
    assert.equal(
      await openLink(link, undefined, labels),
      await ownerPieceKey(labels)
    )
    assert.equal(await shareOwner(parseShareLink(link), T), OWNER.address)
    await assert.rejects(openLink(link, undefined, labelsFor('team')), {
      code: 'other-upload',
    })
  })

  test('a wrong Access key or an expired share says so for any upload, and a same-salt piece in another group is another upload', async () => {
    const labels = labelsFor()
    const { link } = await createShare({
      sender: { owner: OWNER },
      rootCid: ROOT,
      labels,
      mode: 'restricted',
    })
    await assert.rejects(
      openLink(link, accessKeyText(generatePrivateKey()), labelsFor()),
      { code: 'wrong-access-key' }
    )
    const past = Math.floor(Date.now() / 1000) - 3600
    const old = await deliveryShare(labels, { expires: past + 60, now: past })
    await assert.rejects(
      openLink(
        formatShareLink(VIEWER, ROOT, old.payload, old.T),
        undefined,
        labelsFor()
      ),
      { code: 'share-expired' }
    )

    // A Delivery narrowed from group:team to a piece, checked against the same salt in another group.
    const team = labelsFor('team')
    const { bytes } = decodeGrantText(
      await makeGrant({ group: 'team', maxDepth: 1 })
    )
    const held = await openDelivery(SESSION_KEY, bytes)
    const T = generatePrivateKey()
    const node = pieceNode(team)
    const { chain, nodeKey } = await delegateClaim(
      privateKeyToAccount(SESSION_KEY),
      held.chain,
      {
        parentKey: held.key,
        node,
        bearer: privateKeyToAccount(T).address,
        maxDepth: 0,
        piece: team,
      }
    )
    const grant = await wrapTo(
      publicKeyOf(T),
      nodeKey,
      grantDescriptor({ owner: OWNER.address, groupKeyId: GROUP_KEY }, node)
    )
    const sameSalt = pieceMetadata(
      { owner: OWNER.address, groupKeyId: GROUP_KEY },
      {
        salt: (team as unknown as { 'foc/salt': never })['foc/salt'],
        group: 'other',
      }
    )
    await assert.rejects(
      openLink(
        formatShareLink(VIEWER, ROOT, encodeDelivery(chain, grant), T),
        undefined,
        sameSalt
      ),
      { code: 'other-upload' }
    )
  })

  test('a root Delivery opens only its own upload', async () => {
    const labels = labelsFor()
    const { payload, T } = await deliveryShare(labels, { expires: FAR_FUTURE })
    const link = formatShareLink(VIEWER, ROOT, payload, T)
    await assert.rejects(openLink(link, undefined, labelsFor()), {
      code: 'other-upload',
    })
  })

  test('a valid delegation for another upload is another upload, from a group with a space or onward from a piece', async () => {
    const ref = { owner: OWNER.address, groupKeyId: GROUP_KEY }
    const recipient = async (
      chain: Parameters<typeof delegateClaim>[1],
      parentKey: Uint8Array,
      parentBearer: Hex,
      labels: PieceMetadata,
      wrongKey = false
    ) => {
      const T = generatePrivateKey()
      const node = pieceNode(labels)
      const delegated = await delegateClaim(
        privateKeyToAccount(parentBearer),
        chain,
        {
          parentKey,
          node,
          bearer: privateKeyToAccount(T).address,
          maxDepth: 0,
          piece: labels,
        }
      )
      // A wrong key leaves every signature valid: only the commitment check refuses it.
      const grant = await wrapTo(
        publicKeyOf(T),
        wrongKey
          ? crypto.getRandomValues(new Uint8Array(32))
          : delegated.nodeKey,
        grantDescriptor(ref, node)
      )
      return formatShareLink(
        VIEWER,
        ROOT,
        encodeDelivery(delegated.chain, grant),
        T
      )
    }

    // group:Team Files narrowed to a piece.
    const team = labelsFor('Team Files')
    const held = await openDelivery(
      SESSION_KEY,
      decodeGrantText(await makeGrant({ group: 'Team Files', maxDepth: 1 }))
        .bytes
    )
    const fromGroup = await recipient(held.chain, held.key, SESSION_KEY, team)

    // A piece Delivery that its bearer passes on, piece to the same piece.
    const labels = labelsFor()
    const first = generatePrivateKey()
    const { groupKey } = await deriveGroupKey(OWNER, ref)
    const root = await rootClaim(OWNER, {
      ...ref,
      chainId: BigInt(CALIBRATION_CHAIN_ID),
      groupKey,
      node: pieceNode(labels),
      bearer: privateKeyToAccount(first).address,
      maxDepth: 1,
      expires: FAR_FUTURE,
      piece: labels,
    })
    const onward = await recipient(root.chain, root.nodeKey, first, labels)

    for (const [link, own] of [
      [fromGroup, team],
      [onward, labels],
    ] as const) {
      assert.equal(
        await openLink(link, undefined, own),
        await ownerPieceKey(own)
      )
      await assert.rejects(openLink(link, undefined, labelsFor('Team Files')), {
        code: 'other-upload',
      })
    }

    // The same onward Delivery with a wrapped key its claim doesn't commit to is damaged for every upload.
    const damagedOnward = await recipient(
      root.chain,
      root.nodeKey,
      first,
      labels,
      true
    )
    for (const upload of [labels, labelsFor()])
      await assert.rejects(openLink(damagedOnward, undefined, upload), {
        code: 'damaged-link',
      })
  })

  test('a damaged Delivery is a damaged link for any upload', async () => {
    const labels = labelsFor()
    const { payload, T } = await deliveryShare(labels, { expires: FAR_FUTURE })
    const { chain, grant } = decodeDelivery(payload)
    const [root] = chain.links
    assert.ok(root != null)
    const tampered = encodeDelivery(
      { ...chain, links: [{ ...root, maxDepth: 1 }] },
      grant
    )
    const link = formatShareLink(VIEWER, ROOT, tampered, T)
    for (const upload of [labels, labelsFor()])
      await assert.rejects(openLink(link, undefined, upload), {
        code: 'damaged-link',
      })
  })

  test('a Delivery refuses an Access key outside the curve as the wrong one', async () => {
    const labels = labelsFor()
    const { payload, T } = await deliveryShare(labels, { expires: FAR_FUTURE })
    const parsed = parseShareLink(formatShareLink(VIEWER, ROOT, payload, T))
    const zero = `0x${'00'.repeat(32)}` as Hex
    await assert.rejects(shareOwner(parsed, zero), {
      code: 'wrong-access-key',
    })
    await assert.rejects(
      (async () =>
        shareKeyResolver(parsed, zero)({ appMetadata: labels } as never))(),
      { code: 'wrong-access-key' }
    )
  })

  test('an envelope with no Keysmith labels is one this version cannot read, not another upload', async () => {
    const labels = labelsFor()
    const { payload, T } = await deliveryShare(labels, { expires: FAR_FUTURE })
    const parsed = parseShareLink(formatShareLink(VIEWER, ROOT, payload, T))
    await assert.rejects(
      (async () => shareKeyResolver(parsed, T)({ appMetadata: {} } as never))(),
      { code: 'not-encrypted' }
    )
  })
})

describe('Access keys', () => {
  test('an Access key with nothing after its prefix is incomplete', () => {
    assert.throws(() => parseAccessKey('fak1_'), { code: 'incomplete' })
  })
})

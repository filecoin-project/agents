/**
 * Keys and Grants for tests, with the inputs filecoin-pin's tests pin
 * (`src/test/fixtures/group-key-grants.ts` and
 * `src/test/unit/group-key-grant.test.ts` on `feat/encryption-v2`).
 * See `filecoin-pin/NOTICE.md`.
 */

import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { issueGrant, keyAgreementParams } from '../../src/grant.ts'

// The well-known Anvil development keys #0 to #3: public test keys, never funded anywhere real.
/** Anvil #0, the owner in every pinned vector. */
export const OWNER_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** Anvil #1, another wallet. */
export const STRANGER_KEY: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
/** Anvil #2, the session key the golden Grant is wrapped to. */
export const SESSION_KEY: Hex =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
/** Anvil #3, another session key. */
export const OTHER_SESSION_KEY: Hex =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'

/** The owner wallet. */
export const OWNER = privateKeyToAccount(OWNER_KEY)
/** Another wallet. */
export const STRANGER = privateKeyToAccount(STRANGER_KEY)
/** The session key's address. */
export const SESSION_ADDRESS = privateKeyToAccount(SESSION_KEY).address

/** `defaultGroupKeyId(OWNER)`: the group key the console picks for an owner with no encrypted data sets. */
export const GROUP_KEY: Hex = '0x02ca08cf7e0222c8432adc159232b7eb'

/** The group key of filecoin-pin's golden envelopes, from Keysmith's pinned vectors. */
export const VECTOR_GROUP_KEY: Hex = '0x00112233445566778899aabbccddeeff'

/** Calibration's chain id. */
export const CALIBRATION_CHAIN_ID = 314159

/** 2100-01-01: a Grant that outlives every test run. */
export const FAR_FUTURE = 4102444800

/** 2026-01-01, so the golden Grant is checked at a fixed time. */
export const PINNED_NOW = 1767225600

/**
 * A Grant made once by filecoin-pin's `makeGrant()` (Anvil #0 owner, Anvil #2 session
 * key, calibration, the owner's default group key, expiring 2100-01-01). It must keep
 * opening: consoles and CLIs of other versions exchange this text form.
 */
export const GOLDEN_GRANT =
  'fgr1_gwKBqwACAWhncm91cEtleQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEVDxEzd22qQD6K1hd0pngPRL6QpO8BQAGGgAEyy8HUKTAK_v_zb_3Sz5mAaZ0bZwIWEFG8XomGpP0MPKlif23na1MQLEFFhipPX0GNZbtOZtVbEnsqFZxhM0Tq5a53kaP2LBSDM5ZEU3WcH3MOkQtzt5QGwpQpMAr-__Nv_dLPmYBpnRtnAsa9IZXAFi6pwACAWhncm91cEtleQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEWEEEBoUkIEGC2gyP3meS8N2b9UhsyBd3WReZgk7mSKPpS6C32SriAFwr42n4tCRCEkfwYwayZrzr65t4R75nm1wcuAVMtAgEssgVvy1RrhL7Blgw-shWVySbCmDnncKG_XYFLv-tFsqTcdkWlaSISB1gboMHUylMQWkyH0lKC6Lzb0Bn'

/** A Grant made by filecoin-pin 2.4 (Keysmith 0.1.0, format 1), which format 2 refuses as such. */
export const V1_GRANT =
  'fgr1_gwGBqwABAWhrZXlzcGFjZQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEVDxEzd22qQD6K1hd0pngPRL6QpO8BQAGGgAEyy8HUGoMg9KNYHqOiNxnkftJ1-IIWEGdCbSL16RMCZ2Hjsznju8VSTRpq-2RHLu7I-Bporb53VomKJ-goC0IRqON69e6bUOcH7QUKmWcKFlpQI2nT5JjGwpQagyD0o1geo6I3GeR-0nX4gsa9IZXAFi6pwABAWhrZXlzcGFjZQJU85_W5RqtiPb0zmq4gnJ5z_-5ImYDUALKCM9-AiLIQyrcFZIyt-sEWEEEQ9-xkEnBkX7FqCJHDgkGNVOlDBknDtAvJ__SuOQjpQlgLGfm1EvV4j3YxrjJg33xI92pA85BM-J4cgycL0Yl1QVMYIy-eUdXcvuV3NhHBlgwikJobsjiFOwzSVnbA7-WyI7_-0AIn8UgnzuANx3YCl_SQDZrM8iUMIDuNL620d39'

/** What {@link makeGrant} varies. */
export interface GrantInput {
  ownerKey?: Hex
  sessionKey?: Hex
  groupKey?: Hex
  chainId?: number
  expires?: number
  group?: string
  maxDepth?: number
  now?: number
}

/** A Grant (`fgr1_…`) for `sessionKey`, issued by `ownerKey` as the console issues it. */
export async function makeGrant(input: GrantInput = {}): Promise<string> {
  const sessionKey = input.sessionKey ?? SESSION_KEY
  const expires = input.expires ?? FAR_FUTURE
  return issueGrant({
    owner: privateKeyToAccount(input.ownerKey ?? OWNER_KEY),
    groupKeyId: input.groupKey ?? GROUP_KEY,
    chainId: input.chainId ?? CALIBRATION_CHAIN_ID,
    bearer: privateKeyToAccount(sessionKey).address,
    ...(await keyAgreementParams(sessionKey)),
    group: input.group,
    maxDepth: input.maxDepth ?? 0,
    expires,
    // Keysmith refuses to sign an already expired root, so an expired Grant is signed before its expiry.
    now: input.now ?? Math.min(Math.floor(Date.now() / 1000), expires - 3600),
  })
}

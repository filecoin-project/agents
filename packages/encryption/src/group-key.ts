/**
 * Group key rules (Keysmith format 2): which group key an owner writes under,
 * and the data set metadata that names it.
 *
 * One owner wallet signature per group key derives every key beneath it.
 * Nothing is stored: the group key id, a public commitment, and the `foc/enc`
 * format version ride in data set metadata, and every envelope names its own
 * group key and salt.
 *
 * Ported from filecoin-pin's `src/common/group-key.ts` on `feat/encryption-v2`.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/feat/encryption-v2/src/common/group-key.ts
 * @see https://github.com/FilOzone/synapse-sdk/tree/master/packages/keysmith
 * @module
 */

import {
  groupPath,
  COMMITMENT_KEY as KEYSMITH_COMMITMENT_KEY,
  dataSetMetadata as keysmithDataSetMetadata,
  type TypedDataSigner,
} from '@filoz/keysmith'
import {
  type Address,
  concat,
  type Hex,
  isAddress,
  keccak256,
  slice,
  toHex,
} from 'viem'
import { EncryptionError, GroupKeyChoiceError } from './errors.ts'

/**
 * A wallet that can sign Keysmith's `GroupKey` message: the owner's own key,
 * never a session key. A viem local account fits.
 */
export type OwnerSigner = TypedDataSigner & { address: Address }

/** Data set metadata key naming a data set's group key (Keysmith format 2). */
export const GROUP_KEY_ID_KEY = 'foc/gkid'

/**
 * Keysmith 0.1.0's group key id key (format 1). A data set that carries it is
 * encrypted, but format 2 can't write to it.
 */
export const LEGACY_GROUP_KEY_ID_KEY = 'foc/ks'

/** Data set metadata key of the commitment to the group key, `v2.` and 32 hex digits. */
export const COMMITMENT_KEY: typeof KEYSMITH_COMMITMENT_KEY =
  KEYSMITH_COMMITMENT_KEY

/** Data set metadata key that marks a data set as encrypted and versions its rules. */
export const ENCRYPTION_VERSION_KEY = 'foc/enc'

/** The only `foc/enc` value this version writes and reuses. */
export const ENCRYPTION_VERSION = '1'

/**
 * Keys that mark a data set as encrypted. A plain upload never reuses a data
 * set that carries any of them.
 */
export const ENCRYPTED_DATA_SET_KEYS: readonly string[] = Object.freeze([
  GROUP_KEY_ID_KEY,
  LEGACY_GROUP_KEY_ID_KEY,
  COMMITMENT_KEY,
  ENCRYPTION_VERSION_KEY,
])

/** Data set metadata key for who may read its pieces. Absent: providers serve them on open paths. */
export const READ_KEY = 'read'

/** The only `read` value filecoin-pin writes: pieces are served only on the gated `/download` path. */
export const READ_RESTRICTED = 'restricted'

/** A data set's visibility, as filecoin-pin's `data-set show` prints it. */
export type DataSetVisibility =
  | 'public'
  | 'public encrypted'
  | 'private'
  | 'unknown visibility'

/**
 * Whether a data set's metadata marks it as encrypted, by any of
 * {@link ENCRYPTED_DATA_SET_KEYS}. A plain upload must not reuse such a data set.
 *
 * @param metadata - The data set's metadata.
 */
export function isEncryptedDataSet(
  metadata: Readonly<Record<string, string>>
): boolean {
  return ENCRYPTED_DATA_SET_KEYS.some((key) => key in metadata)
}

/**
 * A data set's visibility from its metadata. Any `read` other than
 * `restricted` with `foc/enc` is unknown.
 *
 * @param metadata - The data set's metadata.
 */
export function dataSetVisibility(
  metadata: Readonly<Record<string, string>>
): DataSetVisibility {
  if (READ_KEY in metadata) {
    return metadata[READ_KEY] === READ_RESTRICTED &&
      ENCRYPTION_VERSION_KEY in metadata
      ? 'private'
      : 'unknown visibility'
  }
  return isEncryptedDataSet(metadata) ? 'public encrypted' : 'public'
}

/**
 * A group path in Keysmith's canonical form (`a/b`), checked before any
 * signature or upload.
 *
 * @param group - A group path as the user typed it.
 * @throws {EncryptionError} `bad-group`, with Keysmith's rule and not the group.
 */
export function checkGroup(group: string): string {
  try {
    return groupPath(group)
  } catch (error) {
    // Keysmith's reason ends with the name it refused (`, got "…"`): the message keeps only the rule.
    const reason = error instanceof Error ? error.message : ''
    throw new EncryptionError(
      'bad-group',
      `Invalid group: ${reason.replace(/, got [\s\S]*$/, '') || 'not a group path'}`
    )
  }
}

/**
 * Refuse an address that viem and Keysmith would refuse only after the wallet
 * signed: not 20 bytes of hex, or mixed case with a wrong EIP-55 checksum.
 * The message names no value, because a private key pasted for an address
 * would land in it.
 *
 * @internal
 * @param address - The address to check.
 * @param what - What the address is, for the message: `owner` or `bearer`.
 * @throws {EncryptionError} `bad-address`.
 */
export function checkAddress(address: string, what: string): void {
  if (!isAddress(address))
    throw new EncryptionError(
      'bad-address',
      `The ${what} is not an address, or its mixed case is not a valid EIP-55 checksum`
    )
}

/**
 * The id of an owner's first group key, so every client that sets one up
 * before the first upload picks the same id:
 * `keccak256(utf8("filecoin/default-group-key") ‖ owner as 20 raw bytes)[0:16]`,
 * as `0x` and 32 lowercase hex digits. The owner address is case-insensitive.
 *
 * @param owner - The owner wallet address.
 * @throws {EncryptionError} `bad-address` when `owner` isn't an address.
 */
export function defaultGroupKeyId(owner: Address): Hex {
  // The message names no value: a private key pasted for the address would land in it.
  if (!isAddress(owner, { strict: false }))
    throw new EncryptionError('bad-address', 'The owner is not an address')
  return slice(
    keccak256(
      concat([toHex('filecoin/default-group-key'), owner.toLowerCase() as Hex])
    ),
    0,
    16
  )
}

/**
 * The metadata every encrypted data set of a group key carries: `foc/enc`,
 * `foc/gkid`, and `foc/kc`. Both copies of an upload carry the same values.
 *
 * @param ref - The owner and the group key id.
 * @param commitment - The `v2.` commitment to the group key.
 */
export function encryptedDataSetMetadata(
  ref: { owner: Address; groupKeyId: Hex },
  commitment: string
): Record<string, string> {
  return {
    [ENCRYPTION_VERSION_KEY]: ENCRYPTION_VERSION,
    ...keysmithDataSetMetadata(ref, commitment),
  }
}

/** The parts of a data set the group key rules read. A caller maps its own data set type onto this. */
export interface DataSetInfo {
  /** The on-chain data set id: the oldest data set has the lowest id. */
  dataSetId: bigint
  /** The data set's metadata. */
  metadata: Readonly<Record<string, string>>
  /** False for a terminated data set, which is ignored. Absent counts as live. */
  isLive?: boolean
}

/** A group key the rules skipped, and why, for the caller to log. */
export interface SkippedGroupKey {
  /** The `foc/gkid` as written. */
  groupKeyId: string
  /** The data sets that carry it. */
  dataSetIds: bigint[]
  /** `non-canonical-id`: not `0x` and 32 lowercase hex. `inconsistent`: its data sets disagree on `foc/kc` or aren't all `foc/enc` `"1"`. `bad-commitment`: they agree on a `foc/kc` that isn't Keysmith's `v2.` and 32 lowercase hex. */
  reason: 'non-canonical-id' | 'inconsistent' | 'bad-commitment'
}

/** A group key found in data set metadata, with its commitment. */
export interface RecordedGroupKey {
  /** The group key id (`foc/gkid`). */
  groupKeyId: Hex
  /** The commitment its data sets record (`foc/kc`). */
  commitment: string
  /** Its lowest data set id. */
  oldest: bigint
}

/**
 * A group key id as Keysmith and {@link defaultGroupKeyId} write it: `0x` and
 * 32 lowercase hex. Ids are matched exactly, never case-folded, because data
 * sets are reused by exact metadata.
 */
const CANONICAL_GROUP_KEY_ID = /^0x[0-9a-f]{32}$/

/** A `foc/kc` in the format Keysmith 0.2.0 checks a group key against: `v2.` and 32 lowercase hex. */
const COMMITMENT = /^v2\.[0-9a-f]{32}$/

/**
 * Whether `value` is a commitment Keysmith 0.2.0 can check a group key
 * against: `v2.` and 32 lowercase hex.
 *
 * @internal
 * @param value - A `foc/kc` value.
 */
export const isCommitment = (value: string): boolean => COMMITMENT.test(value)

/**
 * Every valid group key in `dataSets`: grouped by `foc/gkid` as written,
 * skipping any whose id isn't canonical, whose data sets disagree on
 * `foc/kc` or record one Keysmith can't check a key against, or that aren't
 * all `foc/enc` `"1"`.
 *
 * Invalid group keys are skipped rather than refused, so that one bad group
 * key can't block every encrypted upload. `onSkip` hears about each.
 * filecoin-pin and the Filecoin Pay console don't skip a malformed `foc/kc`
 * yet, so for an owner whose oldest group key records one, they pick that
 * group key and this package picks the next.
 *
 * @param dataSets - The owner's data sets. Terminated ones are ignored.
 * @param onSkip - Called for each skipped group key.
 */
export function validGroupKeys(
  dataSets: readonly DataSetInfo[],
  onSkip?: (skipped: SkippedGroupKey) => void
): RecordedGroupKey[] {
  const byGroupKey = new Map<string, DataSetInfo[]>()
  for (const dataSet of dataSets) {
    if (dataSet.isLive === false) continue
    const groupKeyId = dataSet.metadata[GROUP_KEY_ID_KEY]
    if (typeof groupKeyId !== 'string') continue
    // Kept as written: a lookalike spelling is its own (skipped) group key, never merged into a canonical one.
    const members = byGroupKey.get(groupKeyId)
    if (members == null) byGroupKey.set(groupKeyId, [dataSet])
    else members.push(dataSet)
  }

  const valid: RecordedGroupKey[] = []
  for (const [groupKeyId, members] of byGroupKey) {
    const dataSetIds = members.map((dataSet) => dataSet.dataSetId)
    if (!CANONICAL_GROUP_KEY_ID.test(groupKeyId)) {
      onSkip?.({ groupKeyId, dataSetIds, reason: 'non-canonical-id' })
      continue
    }
    const commitments = new Set(
      members.map((dataSet) => dataSet.metadata[COMMITMENT_KEY])
    )
    const commitment = members[0]?.metadata[COMMITMENT_KEY]
    const versioned = members.every(
      (dataSet) =>
        dataSet.metadata[ENCRYPTION_VERSION_KEY] === ENCRYPTION_VERSION
    )
    if (
      commitments.size !== 1 ||
      typeof commitment !== 'string' ||
      !versioned
    ) {
      onSkip?.({ groupKeyId, dataSetIds, reason: 'inconsistent' })
      continue
    }
    if (!isCommitment(commitment)) {
      onSkip?.({ groupKeyId, dataSetIds, reason: 'bad-commitment' })
      continue
    }
    // biome-ignore lint/complexity/useMathMinMax: data set ids are bigints, which Math.min refuses
    const oldest = dataSetIds.reduce((min, id) => (id < min ? id : min))
    valid.push({ groupKeyId: groupKeyId as Hex, commitment, oldest })
  }
  return valid
}

/**
 * "Oldest wins": the valid group key (see {@link validGroupKeys}) that holds
 * the lowest data set id, or undefined when there is none.
 *
 * @param dataSets - The owner's data sets.
 * @param onSkip - Called for each skipped group key.
 */
export function oldestValidGroupKey(
  dataSets: readonly DataSetInfo[],
  onSkip?: (skipped: SkippedGroupKey) => void
): RecordedGroupKey | undefined {
  let best: RecordedGroupKey | undefined
  for (const key of validGroupKeys(dataSets, onSkip)) {
    if (best == null || key.oldest < best.oldest) best = key
  }
  return best
}

/** The group key an owner writes under. */
export interface GroupKeyChoice {
  /** The group key id. */
  groupKeyId: Hex
  /** The recorded commitment, or undefined for a group key with no data set yet. */
  commitment?: string
}

/**
 * The group key an owner encrypts under: the oldest valid one its data sets
 * record, else the owner's default one ({@link defaultGroupKeyId}). Every copy
 * of an upload lands in data sets of this one group key. The Filecoin Pay
 * console picks a Grant's group key the same way.
 *
 * @param owner - The owner wallet address.
 * @param dataSets - The owner's data sets.
 * @param onSkip - Called for each skipped group key.
 * @throws {GroupKeyChoiceError} `invalid-default-group-key`, with the data set ids, when no group key is valid but the default id is already on chain, so writing into it would grow an invalid group key.
 */
export function chooseGroupKey(
  owner: Address,
  dataSets: readonly DataSetInfo[],
  onSkip?: (skipped: SkippedGroupKey) => void
): GroupKeyChoice {
  const recorded = oldestValidGroupKey(dataSets, onSkip)
  if (recorded != null)
    return { groupKeyId: recorded.groupKeyId, commitment: recorded.commitment }
  const groupKeyId = defaultGroupKeyId(owner)
  const invalid = dataSets.filter(
    (dataSet) =>
      dataSet.isLive !== false &&
      dataSet.metadata[GROUP_KEY_ID_KEY] === groupKeyId
  )
  if (invalid.length > 0) {
    const ids = invalid.map((d) => d.dataSetId)
    throw new GroupKeyChoiceError(
      `The default group key ${groupKeyId} is already used by data sets ${ids.join(', ')}, which disagree on foc/kc, record a malformed one, or are not foc/enc "1"`,
      ids
    )
  }
  return { groupKeyId }
}

/** How Keysmith 0.2.0 begins its refusal of format 1 data. */
const FORMAT_1_PREFIX = 'keysmith 0.1.0 (format 1) data is not supported'
/** Every refusal Keysmith 0.2.0 writes, with the subjects its `assertFormatVersion` callers pass. */
const KEYSMITH_FORMAT_1 =
  /^keysmith 0\.1\.0 \(format 1\) data is not supported: (?:a (?:piece label|grant|delivery|presentation|claim link \d{1,3}) with v 1|a v1 commitment|a piece with foc\/ks labels)$/
/** The refusal of format 1 data, for an error that quotes Keysmith's prefix with other words. */
const FORMAT_1_MESSAGE = `${FORMAT_1_PREFIX}: this upload, Grant, or link uses Keysmith 0.1.0 (filecoin-pin 2.3 or 2.4)`

/**
 * Keysmith's refusal of format 1 data (Keysmith 0.1.0, filecoin-pin 2.3 and
 * 2.4), if `error` or one of its causes is it. Keysmith's message is kept
 * only when it is one Keysmith writes; any other is replaced with
 * {@link FORMAT_1_MESSAGE}. Callers show it as it is
 * rather than a generic "not ours" or "corrupted".
 *
 * @param error - Any thrown value.
 */
export function format1Message(error: unknown): string | undefined {
  for (let e = error; e instanceof Error; e = e.cause) {
    // Only Keysmith's own wording is repeated: a resolver's error could put anything after the prefix.
    if (KEYSMITH_FORMAT_1.test(e.message)) return e.message
    if (e.message.includes(FORMAT_1_PREFIX)) return FORMAT_1_MESSAGE
  }
  return undefined
}

import { type Db, table } from '../db.ts'
import type { Network } from '../networks.ts'
import { decodeCursor, type Page, toPage } from '../pagination.ts'
import type { SessionKey, SessionKeyEvent } from '../schemas/resources.ts'
import { sql, where } from '../sql.ts'
import { blockTime, reqAddr } from './map.ts'

/**
 * Names of known Warm Storage EIP-712 typehashes used as session key
 * permissions, including typehashes from earlier synapse-core releases that
 * still appear in onchain authorizations.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/main/packages/synapse-core/src/session-key/permissions.ts
 */
const PERMISSION_NAMES: Readonly<Record<string, string>> = {
  // CreateDataSet(uint256 clientDataSetId,address payee,MetadataEntry[] metadata)...
  '0x25ebf20299107c91b4624d5bac3a16d32cabf0db23b450ee09ab7732983b1dc9':
    'CreateDataSet',
  // AddPieces(uint256 clientDataSetId,uint256 nonce,Cid[] pieceData,PieceMetadata[] pieceMetadata)...
  '0x954bdc254591a7eab1b73f03842464d9283a08352772737094d710a4428fd183':
    'AddPieces',
  // AddPieces(uint256 clientDataSetId,uint256 firstAdded,...) before random nonces
  '0xb557d81ec3b03a60fa3cc207f13ad04af6c95850e1955114d0a0f40919e49ffd':
    'AddPieces',
  // SchedulePieceRemovals(uint256 clientDataSetId,uint256[] pieceIds)
  '0x5415701e313bb627e755b16924727217bb356574fe20e7061442c200b0822b22':
    'SchedulePieceRemovals',
  // TerminateService(uint256 dataSetId)
  '0x522bd88a11de1cdc6574394dde7a21ae488ff13e16e7408d0ea721dd8479dffc':
    'TerminateService',
  // DeleteDataSet(uint256 dataSetId), renamed to TerminateService
  '0xb0988e9a1e5723860e0f59e0469113fb8a0ce9e83f8a1dd9109527eaad225b37':
    'DeleteDataSet',
  // DeleteDataSet(uint256 clientDataSetId), the original typehash
  '0xb5d6b3fc97881f05e96958136ac09d7e0bc7cbf17ea92fce7c431d88132d2b58':
    'DeleteDataSet',
}

/** Filters for {@link listSessionKeys}. */
export interface ListSessionKeysParams {
  identity?: string
  signer?: string
  active?: boolean
  /** Unix time in seconds used to evaluate expiry; defaults to now. */
  now?: number
  limit: number
  cursor?: string
}

/** Filters for {@link listSessionKeyEvents}. */
export interface ListSessionKeyEventsParams {
  identity?: string
  signer?: string
  limit: number
  cursor?: string
}

/** One permission entry as aggregated by {@link listSessionKeys}' SQL. */
interface PermissionRow {
  permission: string
  expiry: string
  origin: string
  blockNumber: string
}

/** A session key folded by {@link listSessionKeys}' SQL. */
interface SessionKeyRow {
  identity: string
  signer: string
  expiry: string
  updated_at_block: string
  permissions: PermissionRow[]
}

/** A `session_key_events` row. */
interface SessionKeyEventRow {
  block_number: string
  log_index: number
  identity: string
  signer: string
  expiry: string
  /** `text[]` sent as `jsonb`, which the driver parses without type fetching. */
  permissions: string[]
  origin: string
  tx_hash: string
}

/** Map an aggregated session key row to the API shape. */
export function mapSessionKey(row: SessionKeyRow, now: number): SessionKey {
  const permissions = row.permissions.map((p) => ({
    permission: p.permission,
    name: PERMISSION_NAMES[p.permission] ?? null,
    expiry: p.expiry,
    active: Number(p.expiry) > now,
    origin: p.origin || null,
    blockNumber: p.blockNumber,
  }))
  return {
    identity: reqAddr(row.identity),
    signer: reqAddr(row.signer),
    active: permissions.some((p) => p.active),
    expiry: row.expiry,
    updatedAtBlock: row.updated_at_block,
    permissions,
  }
}

/**
 * List session keys with the latest expiry of each permission, grouped by
 * (identity, signer).
 */
export async function listSessionKeys(
  db: Db,
  network: Network,
  params: ListSessionKeysParams
): Promise<Page<SessionKey>> {
  const now = params.now ?? Math.floor(Date.now() / 1000)
  // Pages split on (identity, signer), so the cursor can filter permissions
  // before they are grouped.
  const [identity, signer] = params.cursor
    ? decodeCursor(params.cursor, ['address', 'address'])
    : []
  const rows = await db.query<SessionKeyRow>(
    sql`select identity, signer, max(expiry)::text as expiry,
       max(updated_at_block)::text as updated_at_block,
       jsonb_agg(jsonb_build_object(
         'permission', permission, 'expiry', expiry::text, 'origin', origin,
         'blockNumber', updated_at_block::text
       ) order by permission) as permissions
     from ${table(network, 'session_key_permissions')}
     ${where([
       params.identity !== undefined && sql`identity = ${params.identity}`,
       params.signer !== undefined && sql`signer = ${params.signer}`,
       identity !== undefined &&
         sql`(identity, signer) > (${identity}, ${signer})`,
     ])}
     group by identity, signer
     ${where(
       [
         params.active !== undefined &&
           sql`(max(expiry) > ${now}::numeric) = ${params.active}`,
       ],
       'having'
     )}
     order by identity, signer limit ${params.limit + 1}`
  )
  return toPage(
    rows,
    params.limit,
    (r) => mapSessionKey(r, now),
    (r) => [r.identity, r.signer]
  )
}

/** Map a `session_key_events` row to the API shape. */
function mapSessionKeyEvent(
  network: Network,
  row: SessionKeyEventRow
): SessionKeyEvent {
  return {
    identity: reqAddr(row.identity),
    signer: reqAddr(row.signer),
    expiry: row.expiry,
    permissions: row.permissions,
    origin: row.origin || null,
    blockNumber: row.block_number,
    timestamp: blockTime(network, row.block_number),
    txHash: row.tx_hash,
  }
}

/** List raw session key authorization events, newest first. */
export async function listSessionKeyEvents(
  db: Db,
  network: Network,
  params: ListSessionKeyEventsParams
): Promise<Page<SessionKeyEvent>> {
  const [block, index] = params.cursor
    ? decodeCursor(params.cursor, ['int8', 'int8'])
    : []
  const rows = await db.query<SessionKeyEventRow>(
    sql`select block_number, log_index, identity, signer, expiry,
       to_jsonb(permissions) as permissions, origin, tx_hash
     from ${table(network, 'session_key_events')} ${where([
       params.identity !== undefined && sql`identity = ${params.identity}`,
       params.signer !== undefined && sql`signer = ${params.signer}`,
       block !== undefined &&
         sql`(block_number, log_index) < (${block}::bigint, ${index}::int)`,
     ])}
     order by block_number desc, log_index desc limit ${params.limit + 1}`
  )
  return toPage(
    rows,
    params.limit,
    (r) => mapSessionKeyEvent(network, r),
    (r) => [r.block_number, String(r.log_index)]
  )
}

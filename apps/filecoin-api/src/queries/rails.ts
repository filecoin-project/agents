import { type Db, table } from '../db.ts'
import { notFound } from '../errors.ts'
import type { Network } from '../networks.ts'
import { decodeCursor, type Page, toPage } from '../pagination.ts'
import type { Rail, Settlement } from '../schemas/resources.ts'
import { raw, type Sql, sql, where } from '../sql.ts'
import { addr, blockTime, reqAddr } from './map.ts'

/** Rail lifecycle state filter. */
export type RailState = Rail['state']

/** Filters for {@link listRails}. */
export interface ListRailsParams {
  payer?: string
  payee?: string
  operator?: string
  token?: string
  state?: RailState
  limit: number
  cursor?: string
}

/** Pagination for {@link listRailSettlements}. */
export interface ListSettlementsParams {
  railId: string
  limit: number
  cursor?: string
}

/** A `rails` row with the data set it pays for, if any. */
interface RailRow {
  rail_id: string
  payer: string
  payee: string
  token: string
  operator: string
  validator: string
  service_fee_recipient: string
  commission_rate_bps: string
  payment_rate: string
  lockup_period: string
  lockup_fixed: string
  end_epoch: string | null
  terminated_by: string | null
  finalized: boolean
  settled_up_to: string
  total_settled_amount: string
  total_net_payee_amount: string
  total_one_time_amount: string
  total_one_time_net_payee_amount: string
  created_at_block: string
  data_set_id: string | null
}

/** A `rail_settlements` row. */
interface SettlementRow {
  rail_id: string
  block_number: string
  log_index: number
  total_settled_amount: string
  total_net_payee_amount: string
  operator_commission: string
  network_fee: string
  settled_up_to: string
  tx_hash: string
}

/**
 * Rails matching `filter`, newest first, each with the Warm Storage data set
 * it pays for: the PDP, cache-miss or CDN rail of one data set. Rails of
 * other operators have none. The data set lookup runs for the returned page
 * only.
 *
 * @see https://github.com/FilOzone/indexer/blob/main/packages/indexer/docs/rails.md
 */
function railQuery(network: Network, filter: Sql, limit: Sql): Sql {
  return sql`select r.*, d.data_set_id
  from (
    select rail_id, payer, payee, token, operator, validator,
      service_fee_recipient, commission_rate_bps, payment_rate, lockup_period,
      lockup_fixed, end_epoch, terminated_by, finalized, settled_up_to,
      total_settled_amount, total_net_payee_amount, total_one_time_amount,
      total_one_time_net_payee_amount, created_at_block
    from ${table(network, 'rails')}
    ${filter}
    order by rail_id desc limit ${limit}
  ) r
  left join lateral (
    select x.data_set_id from ${table(network, 'data_sets')} x
    where x.pdp_rail_id = r.rail_id or x.cache_miss_rail_id = r.rail_id
      or x.cdn_rail_id = r.rail_id
    limit 1
  ) d on true
  order by r.rail_id desc`
}

const STATE_CONDITIONS: Record<RailState, Sql> = {
  active: raw('end_epoch is null and not finalized'),
  terminated: raw('end_epoch is not null and not finalized'),
  finalized: raw('finalized'),
}

/** Derive the lifecycle state from a rail row. */
export function railState(
  row: Pick<RailRow, 'end_epoch' | 'finalized'>
): RailState {
  if (row.finalized) return 'finalized'
  if (row.end_epoch !== null) return 'terminated'
  return 'active'
}

/** Map a rail row to the API shape. */
function mapRail(network: Network, row: RailRow): Rail {
  return {
    railId: row.rail_id,
    state: railState(row),
    payer: reqAddr(row.payer),
    payee: reqAddr(row.payee),
    token: reqAddr(row.token),
    operator: reqAddr(row.operator),
    validator: reqAddr(row.validator),
    serviceFeeRecipient: reqAddr(row.service_fee_recipient),
    commissionRateBps: row.commission_rate_bps,
    paymentRate: row.payment_rate,
    lockupPeriod: row.lockup_period,
    lockupFixed: row.lockup_fixed,
    endEpoch: row.end_epoch,
    terminatedBy: addr(row.terminated_by),
    settledUpTo: row.settled_up_to,
    totalSettledAmount: row.total_settled_amount,
    totalNetPayeeAmount: row.total_net_payee_amount,
    totalOneTimeAmount: row.total_one_time_amount,
    totalOneTimeNetPayeeAmount: row.total_one_time_net_payee_amount,
    dataSetId: row.data_set_id,
    createdAtBlock: row.created_at_block,
    createdAt: blockTime(network, row.created_at_block),
  }
}

/** List payment rails with their current state, newest rail first. */
export async function listRails(
  db: Db,
  network: Network,
  params: ListRailsParams
): Promise<Page<Rail>> {
  const [id] = params.cursor ? decodeCursor(params.cursor, ['int8']) : []
  const filter = where([
    params.payer !== undefined && sql`payer = ${params.payer}`,
    params.payee !== undefined && sql`payee = ${params.payee}`,
    params.operator !== undefined && sql`operator = ${params.operator}`,
    params.token !== undefined && sql`token = ${params.token}`,
    params.state !== undefined && STATE_CONDITIONS[params.state],
    id !== undefined && sql`rail_id < ${id}::bigint`,
  ])
  const rows = await db.query<RailRow>(
    railQuery(network, filter, sql`${params.limit + 1}`)
  )
  return toPage(
    rows,
    params.limit,
    (r) => mapRail(network, r),
    (r) => [r.rail_id]
  )
}

/** Get one payment rail with its current state; throws 404 when missing. */
export async function getRail(
  db: Db,
  network: Network,
  railId: string
): Promise<Rail> {
  const rows = await db.query<RailRow>(
    railQuery(network, sql`where rail_id = ${railId}::bigint`, raw('1'))
  )
  if (!rows[0]) throw notFound('Rail', railId)
  return mapRail(network, rows[0])
}

/** Map a `rail_settlements` row to the API shape. */
function mapSettlement(network: Network, row: SettlementRow): Settlement {
  return {
    railId: row.rail_id,
    totalSettledAmount: row.total_settled_amount,
    totalNetPayeeAmount: row.total_net_payee_amount,
    operatorCommission: row.operator_commission,
    networkFee: row.network_fee,
    settledUpTo: row.settled_up_to,
    blockNumber: row.block_number,
    timestamp: blockTime(network, row.block_number),
    txHash: row.tx_hash,
  }
}

/** List settlements of one rail, newest first. */
export async function listRailSettlements(
  db: Db,
  network: Network,
  params: ListSettlementsParams
): Promise<Page<Settlement>> {
  const [block, index] = params.cursor
    ? decodeCursor(params.cursor, ['int8', 'int8'])
    : []
  const rows = await db.query<SettlementRow>(
    sql`select rail_id, block_number, log_index, total_settled_amount,
       total_net_payee_amount, operator_commission, network_fee,
       settled_up_to, tx_hash
     from ${table(network, 'rail_settlements')} ${where([
       sql`rail_id = ${params.railId}::bigint`,
       block !== undefined &&
         sql`(block_number, log_index) < (${block}::bigint, ${index}::int)`,
     ])}
     order by block_number desc, log_index desc limit ${params.limit + 1}`
  )
  return toPage(
    rows,
    params.limit,
    (r) => mapSettlement(network, r),
    (r) => [r.block_number, String(r.log_index)]
  )
}

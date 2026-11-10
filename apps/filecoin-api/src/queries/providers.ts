import { type Db, table } from '../db.ts'
import { notFound } from '../errors.ts'
import type { Network } from '../networks.ts'
import { decodeCursor, type Page, toPage } from '../pagination.ts'
import type { Provider } from '../schemas/resources.ts'
import { raw, sql, where } from '../sql.ts'
import { reqAddr } from './map.ts'

/** Filters for {@link listProviders}. */
export interface ListProvidersParams {
  approved?: boolean
  active?: boolean
  endorsed?: boolean
  limit: number
  cursor?: string
}

/** A `providers` row. */
interface ProviderRow {
  provider_id: string
  provider_address: string | null
  name: string | null
  service_url: string | null
  provider_active: boolean
  pdp_product_active: boolean
  approved: boolean
  endorsed: boolean
  created_at_block: string | null
  updated_at_block: string
}

const COLUMNS = raw(`provider_id, provider_address, name, service_url,
  provider_active, pdp_product_active, approved, endorsed,
  created_at_block, updated_at_block`)

/** Map a `providers` row to the API shape. */
function mapProvider(row: ProviderRow): Provider {
  return {
    providerId: row.provider_id,
    address: reqAddr(row.provider_address),
    name: row.name,
    serviceUrl: row.service_url,
    active: row.provider_active,
    pdpProductActive: row.pdp_product_active,
    approved: row.approved,
    endorsed: row.endorsed,
    createdAtBlock: row.created_at_block,
    updatedAtBlock: row.updated_at_block,
  }
}

/** List storage providers, newest id first. */
export async function listProviders(
  db: Db,
  network: Network,
  params: ListProvidersParams
): Promise<Page<Provider>> {
  const [id] = params.cursor ? decodeCursor(params.cursor, ['int8']) : []
  const rows = await db.query<ProviderRow>(
    sql`select ${COLUMNS} from ${table(network, 'providers')} ${where([
      params.approved !== undefined && sql`approved = ${params.approved}`,
      params.active !== undefined && sql`provider_active = ${params.active}`,
      params.endorsed !== undefined && sql`endorsed = ${params.endorsed}`,
      id !== undefined && sql`provider_id < ${id}::bigint`,
    ])}
     order by provider_id desc limit ${params.limit + 1}`
  )
  return toPage(rows, params.limit, mapProvider, (r) => [r.provider_id])
}

/** Get one storage provider by id; throws 404 when it does not exist. */
export async function getProvider(
  db: Db,
  network: Network,
  providerId: string
): Promise<Provider> {
  const rows = await db.query<ProviderRow>(
    sql`select ${COLUMNS} from ${table(network, 'providers')}
     where provider_id = ${providerId}::bigint`
  )
  if (!rows[0]) throw notFound('Provider', providerId)
  return mapProvider(rows[0])
}

/**
 * A provider that `GET /get/{cid}` can redirect to: active, with an active PDP
 * product and an HTTP service URL.
 */
export interface ActiveProvider {
  providerId: string
  /** PDP service URL (Curio) of the provider. */
  serviceUrl: string
  /** `URL.host` of {@link ActiveProvider.serviceUrl}, for matching IPNI addresses. */
  host: string
  endorsed: boolean
  approved: boolean
}

/** An `ActiveProvider` row from {@link listActiveProviders}. */
interface ActiveProviderRow {
  provider_id: string
  service_url: string
  endorsed: boolean
  approved: boolean
}

/**
 * List the providers `GET /get/{cid}` can redirect to, endorsed first, then
 * approved, then by ID. The route caches the list to rank IPNI answers and to
 * check a `provider` hint. Rows whose service URL does not parse are skipped.
 */
export async function listActiveProviders(
  db: Db,
  network: Network
): Promise<ActiveProvider[]> {
  const rows = await db.query<ActiveProviderRow>(
    sql`select provider_id, service_url, endorsed, approved
     from ${table(network, 'providers')}
     where provider_active and pdp_product_active
       and service_url ~ '^https?://'
     order by endorsed desc, approved desc, provider_id asc`
  )
  return rows.flatMap((row) => {
    let host: string
    try {
      host = new URL(row.service_url).host
    } catch {
      return []
    }
    return [
      {
        providerId: row.provider_id,
        serviceUrl: row.service_url,
        host,
        endorsed: row.endorsed,
        approved: row.approved,
      },
    ]
  })
}

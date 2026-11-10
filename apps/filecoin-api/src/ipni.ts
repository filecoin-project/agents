import type { RetrievalCid } from './cid.ts'
import { ApiError, ipniUnavailable } from './errors.ts'

/** Default IPNI instance for {@link findIpniProviders}. */
export const DEFAULT_IPNI_URL = 'https://cid.contact'

/** Milliseconds to wait for an IPNI lookup before it counts as failed. */
export const IPNI_TIMEOUT_MS = 2000

/** Most providers read from one IPNI answer. */
export const IPNI_MAX_PROVIDERS = 20

/**
 * Transport each CID kind needs, by its multicodec name. A trustless gateway
 * serves `/ipfs/{cid}`, and a piece endpoint serves `/piece/{cid}`.
 *
 * @see https://github.com/multiformats/multicodec/blob/master/table.csv
 * @see https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0066.md
 */
export const IPNI_PROTOCOLS = {
  ipfs: 'transport-ipfs-gateway-http',
  piece: 'transport-filecoin-piece-http',
} as const satisfies Record<RetrievalCid['kind'], string>

/** A provider that IPNI lists for a CID, with an https origin to redirect to. */
export interface IpniProvider {
  /** libp2p peer ID of the provider. */
  peerId: string
  /** `https://host` or `https://host:port`, with no path. */
  origin: string
  /** `URL.host` of {@link IpniProvider.origin}, for matching registry providers. */
  host: string
}

/** Where and how {@link findIpniProviders} queries IPNI. */
export interface IpniOptions {
  /** IPNI base URL, such as `https://cid.contact`. */
  url: string
  /** Fetch for the IPNI request; tests inject fakes. */
  fetch: typeof fetch
  /** Aborts the request, such as when the database answers first. */
  signal?: AbortSignal
}

/** A peer record in a delegated routing answer. */
interface PeerRecord {
  Schema?: string
  ID?: string
  Addrs?: string[]
  Protocols?: string[]
}

/**
 * Look up the providers of a CID with IPNI delegated routing, and keep those
 * that serve the CID's kind over https, in IPNI's order. Reads the answer as
 * NDJSON and stops after {@link IPNI_MAX_PROVIDERS} records, so a CID with
 * many providers is never buffered whole. Returns an empty list when IPNI
 * knows no provider, and throws {@link ipniUnavailable} when the lookup
 * fails, times out, or is aborted.
 *
 * @see https://specs.ipfs.tech/routing/http-routing-v1/#get-routing-v1-providers-cid
 */
export async function findIpniProviders(
  cid: RetrievalCid,
  options: IpniOptions
): Promise<IpniProvider[]> {
  const url = new URL(
    `routing/v1/providers/${cid.cid}`,
    options.url.endsWith('/') ? options.url : `${options.url}/`
  )
  const timeout = AbortSignal.timeout(IPNI_TIMEOUT_MS)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  try {
    const res = await options.fetch(url, {
      headers: { Accept: 'application/x-ndjson' },
      signal,
    })
    if (res.status === 404) {
      await res.body?.cancel()
      return []
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      throw ipniUnavailable(`IPNI returned ${res.status}`)
    }
    const protocol = IPNI_PROTOCOLS[cid.kind]
    const providers: IpniProvider[] = []
    for await (const record of readRecords(res.body, IPNI_MAX_PROVIDERS)) {
      const provider = usableProvider(record, protocol)
      if (provider && !providers.some((p) => p.origin === provider.origin)) {
        providers.push(provider)
      }
    }
    return providers
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ipniUnavailable(error instanceof Error ? error.message : 'failed')
  }
}

/**
 * Yield up to `max` JSON records from an NDJSON body, then cancel the rest.
 * Throws on a line that is not JSON.
 */
async function* readRecords(
  body: ReadableStream<Uint8Array>,
  max: number
): AsyncGenerator<PeerRecord> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let count = 0
  try {
    while (count < max) {
      const { done, value } = await reader.read()
      if (value) buffer += value
      const lines = buffer.split('\n')
      buffer = done ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        if (!line.trim()) continue
        yield JSON.parse(line) as PeerRecord
        if (++count >= max) return
      }
      if (done) return
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** The provider of a peer record that has `protocol` and an https address. */
function usableProvider(
  record: PeerRecord,
  protocol: string
): IpniProvider | undefined {
  if (record.Schema !== 'peer' || !record.ID) return undefined
  if (!record.Protocols?.includes(protocol)) return undefined
  for (const addr of record.Addrs ?? []) {
    const origin = httpsOrigin(addr)
    if (origin) return { peerId: record.ID, origin, host: new URL(origin).host }
  }
  return undefined
}

/**
 * The https origin of a DNS multiaddr, such as `/dns/sp.example/tcp/443/https`
 * or `/dns4/sp.example/tcp/8443/tls/http`, or `undefined` for any other
 * address. IP addresses rarely match a certificate, and browsers block plain
 * http from an https page, so both are skipped.
 *
 * @see https://github.com/multiformats/multiaddr/blob/master/protocols.csv
 */
export function httpsOrigin(addr: string): string | undefined {
  const match =
    /^\/dns[46]?\/([^/]+)\/tcp\/(\d+)\/(?:https|tls\/http|tls\/sni\/[^/]+\/http)$/.exec(
      addr
    )
  if (!match) return undefined
  const [, host, port] = match
  try {
    return new URL(`https://${host}:${port}`).origin
  } catch {
    return undefined
  }
}

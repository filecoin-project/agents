import { calibration, mainnet } from '@filoz/synapse-core/chains'
import { createPieceUrlPDP } from '@filoz/synapse-core/piece'
import type { Network } from '../network.ts'
import type { Resource } from '../state/resources.ts'

/**
 * filecoin-api retrieval URLs for stored content. Each redirects to where the
 * content can be fetched; filecoin-api never proxies the bytes.
 *
 * @see ../../../../apps/filecoin-api/README.md#retrieval
 */
export type RetrievalUrls = {
  /** Exact stored bytes: `/get/<pieceCid>` redirects to a provider's `/piece/<pieceCid>`. */
  piece: string
  /**
   * Content a browser renders: `/get/<rootCid>?browser=true` redirects a
   * folder to inbrowser.link, and `/get/<pieceCid>?browser=true` redirects a
   * file to a provider's `/piece/<pieceCid>`.
   */
  browser: string
}

/** Network of a chain ID saved in local state. */
function networkOf(chainId: string): Network {
  if (chainId === mainnet.id.toString()) return 'mainnet'
  if (chainId === calibration.id.toString()) return 'calibration'
  throw new Error(`Unknown chain ID ${chainId}.`)
}

/** filecoin-api `/get/{cid}` URL on `network`. */
function getUrl(
  apiUrl: string,
  network: Network,
  cid: string,
  browser: boolean,
  providerId: string | undefined
): string {
  const url = new URL(
    `get/${encodeURIComponent(cid)}`,
    apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`
  )
  url.searchParams.set('network', network)
  if (browser) url.searchParams.set('browser', 'true')
  if (providerId) url.searchParams.set('provider', providerId)
  return url.toString()
}

/**
 * Build filecoin-api retrieval URLs for a piece and, for folders, its IPFS root.
 * The folder's browser URL names the root CID, so filecoin-api redirects it to
 * inbrowser.link without waiting for its indexer. `providerId` names the
 * provider holding the piece, which filecoin-api redirects to until its indexer
 * has a copy, so a `/piece` link works as soon as the provider has parked
 * the piece. `put` adds it only to the links it reports before the commit
 * confirms. A folder's browser URL leaves it out: filecoin-api never looks it up.
 *
 * @see ../../../../apps/filecoin-api/README.md#retrieval
 */
export function retrievalUrls(options: {
  apiUrl: string
  chainId: string
  pieceCid: string
  rootCid?: string | undefined
  providerId?: string | undefined
}): RetrievalUrls {
  const network = networkOf(options.chainId)
  return {
    piece: getUrl(
      options.apiUrl,
      network,
      options.pieceCid,
      false,
      options.providerId
    ),
    browser: getUrl(
      options.apiUrl,
      network,
      options.rootCid ?? options.pieceCid,
      true,
      options.rootCid ? undefined : options.providerId
    ),
  }
}

/** filecoin-api retrieval URLs for a resource. */
export function resourceUrls(
  resource: Resource,
  apiUrl: string
): RetrievalUrls {
  return retrievalUrls({
    apiUrl,
    chainId: resource.chainId,
    pieceCid: resource.pieceCid,
    rootCid: resource.rootCid,
  })
}

/**
 * Curio `/piece/<pieceCid>` URL of a resource's first copy. `filecoin get`
 * downloads from it directly, so a download never waits for filecoin-api's
 * indexer.
 *
 * @see https://github.com/filecoin-project/curio/blob/main/documentation/en/curio-market/retrievals.md
 */
export function providerPieceUrl(resource: Resource): string {
  const [copy] = resource.copies
  if (!copy) throw new Error(`Resource ${resource.ref} has no stored copies.`)
  return createPieceUrlPDP({
    cid: resource.pieceCid,
    serviceURL: copy.serviceURL.endsWith('/')
      ? copy.serviceURL
      : `${copy.serviceURL}/`,
  })
}

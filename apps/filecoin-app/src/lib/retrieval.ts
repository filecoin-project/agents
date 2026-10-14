import type { Network } from './networks.ts'

/**
 * filecoin-api retrieval URL for a CID: `/get/{cid}` redirects to a provider
 * serving the piece, or to inbrowser.link when the piece has an IPFS root.
 *
 * @param baseUrl - filecoin-api base URL.
 * @param network - Filecoin network.
 * @param cid - PieceCID or IPFS root CID.
 * @see https://github.com/filecoin-project/agents/tree/main/apps/filecoin-api#retrieval
 */
export function retrievalUrl(baseUrl: string, network: Network, cid: string) {
  const url = new URL(
    `get/${encodeURIComponent(cid)}`,
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  )
  url.searchParams.set('network', network)
  url.searchParams.set('browser', 'true')
  return url.toString()
}

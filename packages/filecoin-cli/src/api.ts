import {
  type ApiClient,
  createApiClient,
  type DataSet,
  type Piece,
} from '@filecoin-project/api-client'
import type { App } from './app.ts'

/** Milliseconds each filecoin-api request may take. */
export const API_TIMEOUT = 30_000

/**
 * A typed filecoin-api client for the app's `apiUrl`. Each request aborts with
 * the handler's signal or after {@link API_TIMEOUT}. It calls
 * `globalThis.fetch` at request time, so tests can intercept it.
 *
 * @see ../../filecoin-api-client/README.md
 * @see https://openapi-ts.dev/openapi-fetch/api#createclient
 */
export function apiClientFor(app: Pick<App, 'apiUrl' | 'signal'>): ApiClient {
  return createApiClient({
    baseUrl: app.apiUrl,
    fetch: (request) => {
      const timeout = AbortSignal.timeout(API_TIMEOUT)
      return globalThis.fetch(request, {
        signal: app.signal ? AbortSignal.any([app.signal, timeout]) : timeout,
      })
    },
  })
}

/** Drop `null` values, which filecoin-api uses for fields it has not indexed. */
function present<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}

/**
 * Map a filecoin-api data set to the CLI's output shape. A `pdpEndEpoch` of
 * `0` means the service has not been terminated, so it is omitted.
 */
export function toDataSet(ds: DataSet) {
  const pdpEndEpoch = present(ds.pdpEndEpoch)
  return {
    dataSetId: ds.dataSetId,
    providerId: present(ds.providerId),
    source: present(ds.source),
    withIpfsIndexing: ds.withIpfsIndexing ?? false,
    withCdn: ds.withCdn ?? false,
    metadata: ds.metadata ?? {},
    pdpRailId: ds.pdpRailId,
    pdpEndEpoch: pdpEndEpoch === '0' ? undefined : pdpEndEpoch,
    deleted: ds.deleted ?? false,
    createdAtBlock: present(ds.createdAtBlock),
  }
}

/** Map a filecoin-api piece to the CLI's output shape. */
export function toPiece(piece: Piece) {
  return {
    pieceId: piece.pieceId,
    pieceCid: present(piece.cid),
    rawSize: present(piece.rawSize),
    metadata: piece.metadata ?? {},
    removed: piece.removed ?? false,
    addedAtBlock: present(piece.addedAtBlock),
  }
}

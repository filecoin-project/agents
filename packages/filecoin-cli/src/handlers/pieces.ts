import type { PieceWithDataSet } from '@filecoin-project/api-client'
import { toPiece } from '../api.ts'
import type { App } from '../app.ts'
import { type AccountScope, resourceRefsByCopy } from '../state/resources.ts'
import { getUrl } from '../storage/urls.ts'

/** A piece metadata value when it is a non-empty string. */
function text(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Map filecoin-api pieces to the `storedPiece` output of `ls` and `inspect`.
 * `name` and `rootCid` come from the `name` and `ipfsRootCID` piece metadata
 * that `put` writes, and `url` is the browser URL of the root CID or else the
 * PieceCID. Each piece that a managed resource has a copy at gets that
 * resource's ref from local state.
 *
 * @see ../../../../docs/filecoin/architecture.md#piece-and-data-set-reads
 */
export function storedPieces(
  app: App,
  scope: AccountScope,
  pieces: PieceWithDataSet[]
) {
  const refs = resourceRefsByCopy(
    app.db(),
    scope,
    pieces.map((piece) => piece.dataSetId)
  )
  return pieces.map((piece) => {
    const { pieceId, ...rest } = toPiece(piece)
    const rootCid = text(rest.metadata, 'ipfsRootCID')
    const name = text(rest.metadata, 'name')
    const cid = rootCid ?? rest.pieceCid
    const resourceRef = refs.get(`${piece.dataSetId}/${pieceId}`)
    return {
      dataSetId: piece.dataSetId,
      pieceId,
      ...(piece.providerId ? { providerId: piece.providerId } : {}),
      ...rest,
      ...(rootCid ? { rootCid } : {}),
      ...(name ? { name } : {}),
      ...(cid ? { url: getUrl(app.apiUrl, app.network, cid, true) } : {}),
      ...(resourceRef ? { resourceRef } : {}),
    }
  })
}

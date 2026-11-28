/**
 * Reading an envelope's Keysmith labels before any key is derived, so every
 * reader refuses an envelope it can't open the same way.
 *
 * @module
 */

import { type PieceMetadataView, readPieceMetadata } from '@filoz/keysmith'
import { DecryptError } from '../errors.ts'
import { format1Message } from '../group-key.ts'

/** Why an envelope isn't one this version reads. */
export const NOT_ENCRYPTED =
  'This is not an encrypted upload in the format this version reads'

/**
 * An envelope's Keysmith labels, parsed. Key resolvers call it before they
 * sign, open a Grant, or open a share.
 *
 * @param appMetadata - The envelope's `app_metadata`, from FEE's `parse`.
 * @throws {DecryptError} `format-1` for an upload filecoin-pin 2.3 or 2.4 wrote, `not-encrypted` for labels that aren't Keysmith format 2.
 */
export function readLabels(appMetadata: unknown): PieceMetadataView {
  try {
    return readPieceMetadata(appMetadata as Record<string, unknown>)
  } catch (error) {
    const format1 = format1Message(error)
    if (format1 != null) throw new DecryptError('format-1', format1)
    throw new DecryptError('not-encrypted', NOT_ENCRYPTED)
  }
}

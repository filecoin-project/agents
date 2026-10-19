import { createApiClient } from '@filecoin-project/api-client'
import { env } from '@/config/env'

export {
  ApiError,
  type DataSet,
  type Piece,
  type PieceWithDataSet,
  type Provider,
  type Rail,
  type Schemas,
  type SessionKey,
  type SessionKeyEvent,
  type Settlement,
  unwrap,
} from '@filecoin-project/api-client'

/**
 * Typed filecoin-api REST client for the configured API origin.
 *
 * @see https://openapi-ts.dev/openapi-fetch/
 */
export const api = createApiClient({ baseUrl: env.filApiUrl })

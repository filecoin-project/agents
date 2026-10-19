import { APPLICATION_SOURCE } from '../source.ts'

/**
 * Session-key scope IDs the Filecoin Pay console accepts in its `scopes` link
 * parameter. Kept free of SDK imports so command definitions
 * can validate them; `scopes.ts` maps them to permission hashes.
 */
export const SCOPE_IDS = [
  'createDataSet',
  'addPieces',
  'schedulePieceRemovals',
  'terminateService',
] as const

/** A session-key scope ID. */
export type ScopeId = (typeof SCOPE_IDS)[number]

/** Scopes requested by `filecoin login` unless `--scopes` is given. */
export const DEFAULT_SCOPES: ScopeId[] = [
  'createDataSet',
  'addPieces',
  'schedulePieceRemovals',
]

/** Session-key name `filecoin login` requests unless `--name` is given. */
export const DEFAULT_KEY_NAME = APPLICATION_SOURCE

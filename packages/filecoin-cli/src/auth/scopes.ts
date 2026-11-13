import {
  FwssPermissions,
  type Permission,
} from '@filoz/synapse-core/session-key'
import { SCOPE_IDS, type ScopeId } from './scope-ids.ts'

export { DEFAULT_SCOPES, type ScopeId } from './scope-ids.ts'

/**
 * Every scope ID names an FWSS permission in synapse-core's
 * `FwssPermissions`, which maps the IDs the Filecoin Pay console accepts in
 * its `scopes` link parameter to permission typehashes. This fails to
 * compile if `SCOPE_IDS` names an ID that synapse-core lacks.
 *
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/session-key/permissions.ts
 */
FwssPermissions satisfies Record<ScopeId, Permission>

/** Scopes a `put` needs: it may create a data set or add to one. */
export const PUT_SCOPES: ScopeId[] = ['createDataSet', 'addPieces']

/** Scopes a `delete` needs. */
export const RM_SCOPES: ScopeId[] = ['schedulePieceRemovals']

/** Whether `value` is a known scope ID. */
export function isScopeId(value: string): value is ScopeId {
  return (SCOPE_IDS as readonly string[]).includes(value)
}

/** Map scope IDs to their permission hashes. */
export function toPermissions(scopes: readonly ScopeId[]): Permission[] {
  return scopes.map((scope) => FwssPermissions[scope])
}

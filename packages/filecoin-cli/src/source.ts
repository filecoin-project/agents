/**
 * Application identifier of the `filecoin` CLI. It is the default session-key
 * name, which the registry records as the key's origin, and the data-set
 * `source` metadata that keeps the CLI's data sets apart from other apps'.
 * filecoin-pin uses one constant for both in the same way.
 *
 * @see https://github.com/filecoin-project/filecoin-pin/blob/master/src/core/synapse/constants.ts
 */
export const APPLICATION_SOURCE = 'filecoin-cli'

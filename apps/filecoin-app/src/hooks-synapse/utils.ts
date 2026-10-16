import type { SessionKey } from '@filoz/synapse-core/session-key'
import type { QueryClient } from '@tanstack/react-query'
import { synapseKeys } from './keys'

/** A Synapse session key backed by a secp256k1 private key. */
export type Secp256k1SessionKey = SessionKey<'Secp256k1'>

/**
 * Refresh the caches a storage write changes: data sets, storage size, and
 * the payment state that new or larger rails affect (funds, lockups, FWSS
 * allowance usage, upload costs). synapse-react's storage hooks only refresh
 * their own data sets query, so pass this to their `mutation.onSuccess`.
 *
 * @param queryClient - TanStack Query client.
 * @see https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientinvalidatequeries
 */
export async function invalidateStorageQueries(queryClient: QueryClient) {
  await Promise.all(
    [
      synapseKeys.dataSets,
      synapseKeys.pdpDataSet,
      synapseKeys.storageSize,
      synapseKeys.accountInfo,
      synapseKeys.accountSummary,
      synapseKeys.operatorApprovals,
      synapseKeys.uploadCosts,
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  )
}

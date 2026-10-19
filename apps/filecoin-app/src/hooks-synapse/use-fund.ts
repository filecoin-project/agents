import { fundSync } from '@filoz/synapse-core/pay'
import { getSignerClient } from '@filoz/synapse-react'
import {
  type MutateOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { useChainId, useConfig, useConnection } from 'wagmi'
import { synapseKeys } from './keys'

/** Variables for {@link useFund}. */
export type UseFundVariables = Omit<fundSync.OptionsType, 'onHash'>

/** Props for {@link useFund}. */
export interface UseFundProps {
  /** Called with the transaction hash before waiting for the receipt. */
  onHash?: (hash: string) => void
  /** Mutation options. */
  mutation?: Omit<
    MutateOptions<fundSync.OutputType, Error, UseFundVariables>,
    'mutationFn'
  >
}

/**
 * Approve Warm Storage without spending limits, deposit USDFC with a
 * permit, or both in one transaction, whichever the account still needs.
 *
 * @param props - {@link UseFundProps}
 * @see https://github.com/FilOzone/synapse-sdk/blob/master/packages/synapse-core/src/pay/fund.ts
 */
export function useFund(props?: UseFundProps) {
  const config = useConfig()
  const chainId = useChainId({ config })
  const connection = useConnection({ config })
  const queryClient = useQueryClient()

  return useMutation({
    ...props?.mutation,
    mutationFn: async (variables: UseFundVariables) => {
      const client = await getSignerClient(config, {
        account: connection.address,
        chainId,
      })
      const result = await fundSync(client, {
        ...variables,
        onHash: props?.onHash,
      })
      await Promise.all(
        [
          synapseKeys.accountInfo,
          synapseKeys.erc20Balance,
          synapseKeys.accountSummary,
          synapseKeys.operatorApprovals,
          synapseKeys.uploadCosts,
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
      )
      return result
    },
  })
}

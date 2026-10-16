import {
  getPdpDataSet,
  type PdpDataSet,
} from '@filoz/synapse-core/warm-storage'
import {
  skipToken,
  type UseQueryOptions,
  useQuery,
} from '@tanstack/react-query'
import { useChainId, useConfig } from 'wagmi'
import { synapseKeys } from './keys'

/** Props for {@link usePdpDataSet}. */
export interface UsePdpDataSetProps {
  /** Data set id. */
  dataSetId?: bigint
  /** Chain id; defaults to the connected chain. */
  chainId?: number
  /** Query options. */
  query?: Omit<UseQueryOptions<PdpDataSet | null>, 'queryKey' | 'queryFn'>
}

/**
 * A single Warm Storage data set with rails, provider and metadata.
 *
 * @param props - {@link UsePdpDataSetProps}
 */
export function usePdpDataSet(props: UsePdpDataSetProps) {
  const config = useConfig()
  const connectedChainId = useChainId({ config })
  const chainId = props.chainId ?? connectedChainId
  const dataSetId = props.dataSetId
  return useQuery({
    ...props.query,
    queryKey: [...synapseKeys.pdpDataSet, chainId, dataSetId?.toString()],
    queryFn:
      dataSetId === undefined
        ? skipToken
        : () => getPdpDataSet(config.getClient({ chainId }), { dataSetId }),
  })
}

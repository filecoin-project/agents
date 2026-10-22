import type { Network } from '../networks.ts'

/**
 * Lowercase a nullable address column. Some indexer tables store checksummed
 * addresses; responses always use lowercase.
 */
export function addr(value: string | null): string | null {
  return value?.toLowerCase() ?? null
}

/** Lowercase an address column, using `''` for null (see {@link addr}). */
export function reqAddr(value: string | null): string {
  return (value ?? '').toLowerCase()
}

/**
 * Unix time of a block. Filecoin epochs are exactly 30 seconds from genesis.
 *
 * @see https://spec.filecoin.io/#section-glossary.epoch
 */
export function blockTime(network: Network, block: string): number {
  return network.genesisTimestamp + Number(block) * 30
}

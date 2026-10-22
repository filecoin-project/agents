import { calibration, mainnet } from '@filoz/synapse-core/chains'

/**
 * Schema the FilOzone indexer writes to; every network's database uses the
 * same name.
 *
 * @see https://github.com/FilOzone/indexer
 */
const SCHEMA = 'ozone'

/**
 * Filecoin networks served by the API and the indexer schema behind each.
 * `genesisTimestamp` turns a block number into a Unix time: Filecoin epochs
 * are exactly 30 seconds, so the indexer stores no timestamps.
 *
 * @see https://docs.filecoin.io/networks
 */
export const NETWORKS = {
  calibration: {
    name: 'calibration',
    chainId: 314159,
    binding: 'HYPERDRIVE_CALIBRATION',
    schema: SCHEMA,
    genesisTimestamp: calibration.genesisTimestamp,
  },
  mainnet: {
    name: 'mainnet',
    chainId: 314,
    binding: 'HYPERDRIVE_MAINNET',
    schema: SCHEMA,
    genesisTimestamp: mainnet.genesisTimestamp,
  },
} as const

/** Network name used in the `/{network}` path segment and MCP tool input. */
export type NetworkName = keyof typeof NETWORKS

/** Static configuration of one network. */
export type Network = (typeof NETWORKS)[NetworkName]

/** Every supported network name, in display order. */
export const NETWORK_NAMES = Object.keys(NETWORKS) as [
  NetworkName,
  ...NetworkName[],
]

/**
 * Worker bindings. Every network's Hyperdrive binding is optional so a
 * network can be served before its database is configured. The vars are
 * plain strings, because `wrangler types` reads only the production values,
 * and Previews and local dev set others.
 */
export type Bindings = Omit<
  Env,
  Network['binding'] | 'MCP_HOSTS' | 'MCP_PUBLIC_URL'
> & {
  [K in Network['binding']]?: Hyperdrive
} & {
  MCP_HOSTS: string
  MCP_PUBLIC_URL: string
}

/** Whether `name` is a supported network. */
export function isNetworkName(name: string): name is NetworkName {
  return Object.hasOwn(NETWORKS, name)
}

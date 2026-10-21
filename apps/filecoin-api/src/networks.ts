/** Indexer schemas; every network's database uses the same names. */
const SCHEMAS = { observer: 'foc-observer', repair: 'early-repair' } as const

/**
 * Filecoin networks served by the API and the indexer schemas behind each.
 *
 * @see https://docs.filecoin.io/networks
 */
export const NETWORKS = {
  calibration: {
    name: 'calibration',
    chainId: 314159,
    binding: 'HYPERDRIVE_CALIBRATION',
    schemas: SCHEMAS,
  },
  mainnet: {
    name: 'mainnet',
    chainId: 314,
    binding: 'HYPERDRIVE_MAINNET',
    schemas: SCHEMAS,
  },
} as const

/** Network name used in the `/{network}` path segment and MCP tool input. */
export type NetworkName = keyof typeof NETWORKS

/** Static configuration of one network. */
export type Network = (typeof NETWORKS)[NetworkName]

/** Indexer schema names for one network. */
export type Schemas = Network['schemas']

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

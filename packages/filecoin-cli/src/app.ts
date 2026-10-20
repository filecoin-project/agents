import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  calibration,
  type FilecoinChain,
  mainnet,
} from '@filoz/synapse-core/chains'
import { getTransport } from '@filoz/synapse-core/client'
import { type Client, createPublicClient, http, type Transport } from 'viem'
import type { LinkTags } from './auth/login.ts'
import { type Config, type Network, resolveNetwork } from './config.ts'
import { abortable } from './errors.ts'
import {
  DEFAULT_API_URL,
  DEFAULT_CONSOLE_URL,
  type GlobalSettings,
} from './globals.ts'
import { openDatabase } from './state/db.ts'

/**
 * Shared per-invocation context: resolved network, chain client, config, and
 * lazily opened local state.
 */
export type App = {
  network: Network
  chain: FilecoinChain
  config: Config
  /** Session key and owner given as input (`FILECOIN_SESSION_KEY`, `FILECOIN_ROOT_ADDRESS`). */
  credentials: { sessionKey?: string; rootAddress?: string }
  /** Filecoin Pay console origin for session-key approval and funding links. */
  consoleUrl: string
  /** Analytics tags for console links; `undefined` when the user opted out. */
  linkTags: LinkTags | undefined
  /** filecoin-api origin for retrieval links. */
  apiUrl: string
  /** `FILECOIN_RPC_URL`, which replaces the chain's fallback transport. */
  rpcUrl: string | undefined
  /** The CLI's folder (`ctx.dir()`), which holds the state database and staged input. */
  dir: string
  /** Aborted on SIGINT, SIGTERM, or SIGHUP; cancels chain and provider calls. */
  signal: AbortSignal | undefined
  /** RPC transport for the resolved chain, bound to `signal`. */
  transport: Transport
  /** Read-only chain client. */
  client: Client<Transport, FilecoinChain>
  /** Open the state database on first use. */
  db: () => DatabaseSync
  /** Staging directory for an operation's prepared input. */
  stagingDir: (operationId: string) => string
}

/**
 * Options for {@link createApp}: the opened config store, the CLI's folder,
 * the shared account input of a command, and the CLI's globals. Omitted
 * globals take their defaults.
 */
export type CreateAppOptions = Partial<GlobalSettings> & {
  /** The `config.json` store, from `store.get(ctx)`. */
  config: Config
  /** The CLI's folder, from `ctx.dir()`. */
  dir: string
  /** `--network` or `FILECOIN_NETWORK`; falls back to the config file. */
  network?: Network | undefined
  /** `FILECOIN_SESSION_KEY`, for CI without `filecoin login`. */
  sessionKey?: string | undefined
  /** `FILECOIN_ROOT_ADDRESS`, the wallet that authorized `sessionKey`. */
  rootAddress?: string | undefined
  /** The handler's signal; every RPC request rejects once it aborts. */
  signal?: AbortSignal
  /** Analytics tags for console links; leave out for untagged links. */
  linkTags?: LinkTags | undefined
}

/**
 * Bind `transport` to `signal`: a request rejects as soon as the signal
 * aborts, and none starts after it. synapse-core and viem read actions take
 * no signal of their own. The signal is not passed down: viem's http
 * transport would use it in place of its own timeout, so requests would no
 * longer time out, and the fallback transport drops it anyway.
 */
export function withSignal(
  transport: Transport,
  signal: AbortSignal
): Transport {
  return (options) => {
    const inner = transport(options)
    return {
      ...inner,
      request: (args, requestOptions) =>
        signal.aborted
          ? Promise.reject(signal.reason)
          : abortable(inner.request(args, requestOptions), signal),
    }
  }
}

/**
 * Build the invocation context from a command's account input. Handlers call
 * this directly; clipact has no middleware. `rpcUrl` replaces the chain's
 * default fallback transport.
 */
export function createApp(options: CreateAppOptions): App {
  const { config, dir } = options
  const network = resolveNetwork(options.network, config)
  const chain = network === 'mainnet' ? mainnet : calibration
  const base = options.rpcUrl ? http(options.rpcUrl) : getTransport(chain)
  const transport = options.signal ? withSignal(base, options.signal) : base
  let db: DatabaseSync | undefined
  return {
    network,
    chain,
    config,
    credentials: {
      sessionKey: options.sessionKey,
      rootAddress: options.rootAddress,
    },
    consoleUrl: options.consoleUrl ?? DEFAULT_CONSOLE_URL,
    linkTags: options.linkTags,
    apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    rpcUrl: options.rpcUrl,
    dir,
    signal: options.signal,
    transport,
    client: createPublicClient({ chain, transport }),
    db: () => {
      db ??= openDatabase(dir)
      return db
    },
    stagingDir: (operationId) => join(dir, 'staging', operationId),
  }
}

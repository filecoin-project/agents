import { defineStore } from 'clipact'
import * as z from 'zod'
import { DEFAULT_NETWORK, NETWORKS, type Network } from './network.ts'

/** Networks the CLI can target. */
export const NetworkSchema = z.enum(NETWORKS)

export type { Network } from './network.ts'

/**
 * A session key saved by `filecoin login`. `rootAddress` is absent while the
 * login is pending approval in the Filecoin Pay console.
 */
export const SessionSchema = z.object({
  privateKey: z.string(),
  address: z.string(),
  rootAddress: z.string().optional(),
  scopes: z.array(z.string()),
  /** Name requested for the key, recorded on chain as its origin. */
  name: z.string().optional(),
  /** Days until the requested authorization expires. */
  days: z.number().int().optional(),
  /** Block height when the key was created, used to scan for its approval. */
  fromBlock: z.string(),
  /** Earliest expiry among the granted scopes, in Unix seconds. */
  expiresAt: z.string().optional(),
  createdAt: z.string(),
})

/** A saved session. */
export type StoredSession = z.infer<typeof SessionSchema>

/** Persisted CLI configuration. */
export const ConfigSchema = z.object({
  /** Default network; `resolveNetwork` falls back to calibration. */
  network: NetworkSchema.optional(),
  sessions: z
    .object({
      mainnet: SessionSchema.optional(),
      calibration: SessionSchema.optional(),
    })
    .default({}),
})

/**
 * The CLI's store: `config.json` in clipact's folder for `filecoin`, which
 * `FILECOIN_CONFIG_DIR` moves. clipact writes it atomically with mode 0600
 * under a lock, and reports a corrupt file as `config_invalid`.
 *
 * @see https://github.com/hugomrdias/agents/tree/main/packages/clipact#storage
 */
export const store = defineStore({ schema: ConfigSchema })

/** The opened configuration store, an iso-conf `Conf`. */
export type Config = Awaited<ReturnType<typeof store.get>>

/**
 * Resolve the network: the command input (a `--network` flag or
 * `FILECOIN_NETWORK`, merged by clipact), then the config file, then calibration.
 */
export function resolveNetwork(
  input: Network | undefined,
  config: Pick<Config, 'get'>
): Network {
  return input ?? config.get('network') ?? DEFAULT_NETWORK
}

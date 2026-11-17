import * as z from 'zod'
import { NETWORKS } from '../network.ts'

/**
 * Input every command that talks to the chain accepts. clipact has no global
 * options, so each command spreads this into its input schema.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#defining-commands
 */
export const account = {
  network: z
    .enum(NETWORKS)
    .optional()
    .describe(
      'Network (default: FILECOIN_NETWORK, then the config file, then calibration)'
    ),
  sessionKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'Expected a 32-byte hex private key')
    .optional()
    .describe('Session key for CI, instead of the one saved by filecoin login'),
  rootAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 20-byte hex address')
    .optional()
    .describe('Wallet that authorized FILECOIN_SESSION_KEY'),
}

/** Environment variables for {@link account}; `sessionKey` is a secret. */
export const accountEnv = {
  network: 'FILECOIN_NETWORK',
  sessionKey: 'FILECOIN_SESSION_KEY',
  rootAddress: 'FILECOIN_ROOT_ADDRESS',
} as const

/** Page size and cursor of list commands. */
export const paging = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum results per page'),
  cursor: z.string().optional().describe('nextCursor of the previous page'),
}

/** One on-chain storage occurrence of a resource. IDs are decimal strings. */
export const copy = z.object({
  providerId: z.string(),
  dataSetId: z.string(),
  pieceId: z.string(),
  serviceURL: z.string(),
})

/** A file or folder managed by `filecoin`. */
export const resource = z.object({
  ref: z.string(),
  kind: z.enum(['file', 'folder']),
  name: z.string(),
  chainId: z.string(),
  payer: z.string(),
  pieceCid: z.string(),
  rootCid: z.string().optional(),
  size: z.number().int().describe('Stored bytes'),
  copies: z.array(copy),
  url: z.string().optional(),
  status: z.enum(['active', 'removal_pending']),
  createdAt: z.string(),
})

/**
 * One piece the wallet pays for, from filecoin-api. `name` and `rootCid` come
 * from the piece metadata that `put` writes; `resourceRef` from local state.
 */
export const storedPiece = z.object({
  dataSetId: z.string(),
  pieceId: z.string(),
  providerId: z.string().optional(),
  pieceCid: z.string().optional(),
  rootCid: z
    .string()
    .optional()
    .describe('IPFS root CID, from the ipfsRootCID piece metadata'),
  name: z.string().optional().describe('From the name piece metadata'),
  rawSize: z.string().optional().describe('Bytes before padding'),
  metadata: z.record(z.string(), z.unknown()),
  removed: z.boolean(),
  addedAtBlock: z.string().optional(),
  url: z
    .string()
    .optional()
    .describe('filecoin-api link a browser renders; absent without a CID'),
  resourceRef: z
    .string()
    .optional()
    .describe('Managed resource stored as this piece, from local state'),
})

/** filecoin-api retrieval URLs, which redirect to a provider or a gateway. */
export const urls = z.object({
  piece: z.string().describe('Exact stored bytes'),
  browser: z
    .string()
    .describe('Link a browser renders: a folder through inbrowser.link'),
})

/** A provider that failed to store a copy, and why. */
export const copyFailure = z.object({
  providerId: z.string().optional(),
  error: z.string(),
})

/** Result of a put, or of a resumed put. */
export const putResult = {
  operationId: z.string(),
  state: z.literal('ready'),
  resource,
  urls,
  requestedCopies: z
    .number()
    .int()
    .optional()
    .describe(
      'Copies a put asked for; fewer resource.copies means some failed'
    ),
  copyFailures: z
    .array(copyFailure)
    .optional()
    .describe('Providers that failed to store a copy, including replaced ones'),
}

/** One stored copy a delete removes or skips. */
export const removal = z.object({
  dataSetId: z.string(),
  pieceId: z.string(),
  providerId: z.string(),
  source: z
    .string()
    .optional()
    .describe(
      'Application that created the data set, from its source metadata'
    ),
  resourceRef: z
    .string()
    .optional()
    .describe('Managed resource with this copy, from local state'),
  state: z
    .enum(['live', 'scheduled', 'already_scheduled', 'removed'])
    .describe(
      'live: a dry run found it stored; scheduled: this delete scheduled its removal; already_scheduled or removed: skipped, nothing signed'
    ),
  transactionHash: z.string().optional(),
})

/** Result of a delete, or of a resumed delete. */
export const removeResult = {
  operationId: z.string(),
  state: z.literal('removal_pending'),
  target: z
    .string()
    .describe('Resource ref, PieceCID, root CID, or <dataSetId>/<pieceId>'),
  removals: z.array(removal),
  resources: z
    .array(resource)
    .describe(
      'Managed resources with a copy among the removals, as saved after the delete'
    ),
}

/** Formats a delete's copies for humans, one line each. */
export function formatRemovals(removals: z.input<typeof removal>[]): string[] {
  return removals.map((r) =>
    [
      `${r.dataSetId}/${r.pieceId}`.padEnd(12),
      `provider ${r.providerId}`,
      r.source ?? '',
      r.resourceRef ?? '',
      r.state,
    ]
      .filter(Boolean)
      .join('  ')
  )
}

/** Execution state of an operation. */
export const executionStatus = z.enum([
  'pending',
  'running',
  'failed',
  'completed',
])

/** One line of an operation list. */
export const operationSummary = z.object({
  id: z.string(),
  action: z.enum(['put', 'delete']),
  resourceRef: z
    .string()
    .optional()
    .describe('Absent for a delete whose pieces no managed resource holds'),
  target: z
    .string()
    .optional()
    .describe('What a delete named: a ref, PieceCID, root CID, or pair'),
  phase: z.string(),
  executionStatus,
  updatedAt: z.string(),
  error: z.string().optional(),
})

/** Formats a byte count for humans. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/**
 * A Warm Storage data set as filecoin-api indexes it. IDs and epochs are
 * decimal strings; fields the indexer has not filled are omitted.
 *
 * @see ../../../filecoin-api-client/src/schema.ts
 */
export const dataSet = z.object({
  dataSetId: z.string(),
  providerId: z.string().optional(),
  source: z
    .string()
    .optional()
    .describe('Application that created it, from its source metadata'),
  withIpfsIndexing: z
    .boolean()
    .describe('The provider indexes its CARs and announces them to IPNI'),
  withCdn: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  pdpRailId: z.string().describe('Filecoin Pay storage rail'),
  pdpEndEpoch: z
    .string()
    .optional()
    .describe('Epoch the service ends at; set once it is terminated'),
  deleted: z.boolean().describe('Deleted on chain'),
  createdAtBlock: z.string().optional(),
})

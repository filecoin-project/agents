import { defineCommand } from 'clipact'
import * as z from 'zod'
import { ErrorCodes, STORAGE_ERRORS } from '../errors.ts'
import { account, accountEnv, formatBytes, paging } from './shared.ts'

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

/** `filecoin ls`: the wallet's pieces from filecoin-api, newest first. */
export const ls = defineCommand({
  name: 'ls',
  description: "List the wallet's stored pieces, newest first",
  examples: [
    'filecoin ls',
    'filecoin ls --provider 9',
    'filecoin ls --all --limit 50',
  ],
  input: z.strictObject({
    ...paging,
    provider: z
      .string()
      .regex(/^\d+$/, 'Expected a decimal provider ID')
      .optional()
      .describe('Only pieces with this storage provider'),
    all: z
      .boolean()
      .default(false)
      .describe('Include pieces removed from their data sets'),
    ...account,
  }),
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    network: z.string(),
    pieces: z.array(storedPiece),
    nextCursor: z.string().optional(),
  }),
  errors: [...STORAGE_ERRORS, ErrorCodes.authRequired, ErrorCodes.loginPending],
  readOnly: true,
  human: (data) =>
    data.pieces.length === 0
      ? `No pieces on ${data.network}.`
      : [
          ...data.pieces.map((p) =>
            [
              `${p.dataSetId}/${p.pieceId}`.padEnd(12),
              (p.rawSize ? formatBytes(Number(p.rawSize)) : '?').padStart(10),
              p.name ?? '',
              p.resourceRef ?? '',
              p.rootCid ?? p.pieceCid ?? '',
              p.removed ? 'removed' : '',
            ]
              .filter(Boolean)
              .join('  ')
          ),
          ...(data.nextCursor ? [`more: --cursor ${data.nextCursor}`] : []),
        ].join('\n'),
  handler: () => import('../handlers/ls.ts'),
})

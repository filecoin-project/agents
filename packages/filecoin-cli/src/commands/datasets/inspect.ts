import { defineCommand } from 'clipact'
import * as z from 'zod'
import { ErrorCodes, STORAGE_ERRORS } from '../../errors.ts'
import { account, accountEnv, dataSet, formatBytes, paging } from '../shared.ts'

/** One piece of a data set, linked to its managed resource when there is one. */
export const dataSetPiece = z.object({
  pieceId: z.string(),
  pieceCid: z.string().optional(),
  rawSize: z.string().optional().describe('Bytes before padding'),
  metadata: z.record(z.string(), z.unknown()),
  removed: z.boolean(),
  addedAtBlock: z.string().optional(),
  resourceRef: z
    .string()
    .optional()
    .describe('Managed resource stored as this piece, from local state'),
})

/** `filecoin datasets inspect <id>`: a data set, its provider, and its pieces. */
export const inspect = defineCommand({
  name: 'inspect',
  description: 'Show a data set with its provider and pieces',
  examples: [
    'filecoin datasets inspect 39723',
    'filecoin datasets inspect 39723 --removed',
  ],
  input: z.strictObject({
    id: z
      .string()
      .regex(/^\d+$/, 'Expected a decimal data set ID')
      .describe('Data set ID'),
    ...paging,
    removed: z
      .boolean()
      .default(false)
      .describe('Include pieces removed from the data set'),
    ...account,
  }),
  positionals: ['id'],
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    network: z.string(),
    dataSet,
    provider: z
      .object({
        providerId: z.string(),
        name: z.string().optional(),
        serviceURL: z.string().optional(),
      })
      .optional(),
    pieces: z.array(dataSetPiece),
    nextCursor: z
      .string()
      .optional()
      .describe('Cursor for the next page of pieces'),
  }),
  errors: [
    ...STORAGE_ERRORS,
    ErrorCodes.authRequired,
    ErrorCodes.loginPending,
    ErrorCodes.notFound,
  ],
  readOnly: true,
  human: ({ dataSet: ds, provider, pieces, nextCursor }) =>
    [
      `data set ${ds.dataSetId}${ds.deleted ? ' (deleted)' : ''}`,
      `provider: ${provider ? `${provider.providerId} ${provider.name ?? ''} ${provider.serviceURL ?? ''}`.trim() : (ds.providerId ?? '?')}`,
      ...(ds.source ? [`source: ${ds.source}`] : []),
      `ipfs indexing: ${ds.withIpfsIndexing ? 'yes' : 'no'}`,
      `rail: ${ds.pdpRailId}`,
      ...(ds.pdpEndEpoch ? [`ends at epoch: ${ds.pdpEndEpoch}`] : []),
      pieces.length === 0 ? 'pieces: none' : 'pieces:',
      ...pieces.map((p) =>
        [
          `  ${p.pieceId.padEnd(6)}`,
          p.pieceCid ?? '?',
          p.rawSize ? formatBytes(Number(p.rawSize)) : '',
          p.resourceRef ?? '',
          p.removed ? 'removed' : '',
        ]
          .filter(Boolean)
          .join('  ')
      ),
      ...(nextCursor ? [`more: --cursor ${nextCursor}`] : []),
    ].join('\n'),
  handler: () => import('../../handlers/datasets/inspect.ts'),
})

import { defineCommand } from 'clipact'
import * as z from 'zod'
import { ErrorCodes, STORAGE_ERRORS } from '../../errors.ts'
import { account, accountEnv, dataSet, paging } from '../shared.ts'

/** `filecoin datasets ls`: the wallet's data sets from filecoin-api, newest first. */
export const ls = defineCommand({
  name: 'ls',
  description: "List the wallet's data sets, newest first",
  examples: [
    'filecoin datasets ls',
    'filecoin datasets ls --provider 9',
    'filecoin datasets ls --all',
  ],
  input: z.strictObject({
    ...paging,
    provider: z
      .string()
      .regex(/^\d+$/, 'Expected a decimal provider ID')
      .optional()
      .describe('Only data sets with this storage provider'),
    all: z
      .boolean()
      .default(false)
      .describe('Include data sets deleted on chain'),
    ...account,
  }),
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    network: z.string(),
    dataSets: z.array(dataSet),
    nextCursor: z.string().optional(),
  }),
  errors: [...STORAGE_ERRORS, ErrorCodes.authRequired, ErrorCodes.loginPending],
  readOnly: true,
  human: (data) =>
    data.dataSets.length === 0
      ? `No data sets on ${data.network}.`
      : [
          ...data.dataSets.map((ds) =>
            [
              ds.dataSetId.padEnd(8),
              `provider ${ds.providerId ?? '?'}`.padEnd(14),
              ds.withIpfsIndexing ? 'ipfs' : '    ',
              ds.source ?? '',
              ds.deleted
                ? 'deleted'
                : ds.pdpEndEpoch
                  ? `ends at epoch ${ds.pdpEndEpoch}`
                  : '',
            ]
              .filter(Boolean)
              .join('  ')
              .trimEnd()
          ),
          ...(data.nextCursor ? [`more: --cursor ${data.nextCursor}`] : []),
        ].join('\n'),
  handler: () => import('../../handlers/datasets/ls.ts'),
})

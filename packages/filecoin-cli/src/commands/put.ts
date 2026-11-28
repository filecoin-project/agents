import { defineCommand } from 'clipact'
import * as z from 'zod'
import { JOB_ERRORS } from '../errors.ts'
import {
  account,
  accountEnv,
  copyFailure,
  formatBytes,
  resource,
  urls,
} from './shared.ts'

/** What `put --dry-run` reports instead of storing anything. */
const estimate = z.object({
  kind: z.enum(['file', 'folder']),
  name: z.string(),
  size: z
    .number()
    .int()
    .describe('Bytes to store: the packed CAR, or the raw file'),
  files: z.number().int(),
  rootCid: z
    .string()
    .optional()
    .describe('IPFS root CID of the CAR; absent with --raw'),
  network: z.string(),
  authorization: z
    .enum(['ready', 'login_required', 'login_pending', 'scopes_missing'])
    .describe('Whether the session key can sign this put'),
  missingScopes: z.array(z.string()).optional(),
  provider: z
    .object({
      id: z.string(),
      serviceURL: z.string(),
      dataSetId: z.string().optional().describe('Existing data set to add to'),
    })
    .optional(),
  secondaryProvider: z
    .object({
      id: z.string(),
      serviceURL: z.string(),
      dataSetId: z.string().optional().describe('Existing data set to add to'),
    })
    .optional()
    .describe('Provider of the second copy; absent when none answers'),
  cost: z
    .object({
      token: z.literal('USDFC'),
      ready: z.boolean().describe('The payer can cover it now'),
      depositNeeded: z.string(),
      needsApproval: z.boolean(),
      ratePerMonth: z.string().describe('Every copy together'),
      lockup: z.string().describe('Every copy together'),
      fundingUrl: z.string().optional(),
    })
    .optional(),
  checkedAt: z.string(),
})

/**
 * `filecoin put <path>`: store a file or directory as a UnixFS CAR served
 * at `/ipfs/<rootCid>`, or with `--raw` a file as its exact bytes, with two
 * copies on two providers.
 */
export const put = defineCommand({
  name: 'put',
  description:
    'Store a file or directory as an IPFS-indexed UnixFS CAR with two copies',
  examples: [
    'filecoin put ./report.pdf',
    'filecoin put ./report.pdf --raw',
    'filecoin put ./site --name docs',
    'filecoin put ./site --include-hidden --dry-run',
    'filecoin put ./site --include-hidden',
    'filecoin put ./site --dry-run',
  ],
  input: z.strictObject({
    path: z.string().describe('File or directory to store'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Display name (default: basename)'),
    provider: z
      .string()
      .regex(/^\d+$/, 'Expected a decimal provider ID')
      .optional()
      .describe('Storage provider ID of the first copy (default: automatic)'),
    raw: z
      .boolean()
      .default(false)
      .describe(
        'Store a file as its exact bytes, without a UnixFS CAR or IPFS indexing'
      ),
    includeHidden: z
      .boolean()
      .default(false)
      .describe(
        "Include all of a folder's hidden files and directories, such as .env, .git, and .DS_Store, which become public. Pass it with --dry-run too. To store only some of them, put a folder that holds just the files to publish"
      ),
    ...account,
  }),
  positionals: ['path'],
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    dryRun: z.boolean(),
    operationId: z.string().optional().describe('Set when dryRun is false'),
    state: z.literal('ready').optional(),
    resource: resource.optional(),
    urls: urls.optional(),
    requestedCopies: z
      .number()
      .int()
      .optional()
      .describe('Copies asked for; fewer resource.copies means some failed'),
    copyFailures: z
      .array(copyFailure)
      .optional()
      .describe(
        'Providers that failed to store a copy, including replaced ones'
      ),
    estimate: estimate.optional().describe('Set when dryRun is true'),
  }),
  errors: JOB_ERRORS,
  dryRun: true,
  human: (data) => {
    if (data.estimate) {
      const e = data.estimate
      const lines = [
        `Would store ${e.kind} ${e.name}: ${formatBytes(e.size)}, ${e.files} file(s) on ${e.network}`,
        ...(e.rootCid ? [`rootCid: ${e.rootCid}`] : []),
        `authorization: ${e.authorization}`,
      ]
      if (e.provider)
        lines.push(`provider: ${e.provider.id} (${e.provider.serviceURL})`)
      if (e.secondaryProvider)
        lines.push(
          `second copy: ${e.secondaryProvider.id} (${e.secondaryProvider.serviceURL})`
        )
      if (e.cost) {
        lines.push(
          `cost: ${e.cost.ratePerMonth} USDFC/month, lockup ${e.cost.lockup} USDFC, ${e.cost.ready ? 'funded' : `deposit ${e.cost.depositNeeded} USDFC first`}`
        )
      }
      return lines.join('\n')
    }
    const stored = data.resource?.copies.length ?? 0
    const requested = data.requestedCopies ?? stored
    return [
      `Stored ${data.resource?.name} (${data.resource?.ref})`,
      `copies: ${stored} of ${requested}`,
      ...(stored < requested
        ? (data.copyFailures ?? []).map(
            (f) =>
              `  failed${f.providerId ? ` on provider ${f.providerId}` : ''}: ${f.error}`
          )
        : []),
      ...(data.resource?.rootCid ? [`rootCid: ${data.resource.rootCid}`] : []),
      data.urls?.browser,
    ].join('\n')
  },
  handler: () => import('../handlers/put.ts'),
})

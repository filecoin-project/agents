import { defineCommand } from 'clipact'
import * as z from 'zod'
import { JOB_ERRORS } from '../errors.ts'
import {
  account,
  accountEnv,
  formatRemovals,
  removal,
  removeResult,
  resource,
} from './shared.ts'

/**
 * The confirmation for a delete, by what the target looks like. It is a
 * function of the input alone, so it can't list the copies; `--dry-run`
 * does.
 */
function confirmReason(input: { target: string; provider?: string }): string {
  const on = input.provider ? ` on provider ${input.provider}` : ''
  const list = 'Run with --dry-run to list the copies.'
  if (input.target.startsWith('res_')) {
    return `Schedules removal of every copy of ${input.target}${on}; the providers delete the stored data. ${list}`
  }
  const pair = /^(\d+)\/(\d+)$/.exec(input.target)
  if (pair) {
    return `Schedules removal of piece ${pair[2]} from data set ${pair[1]}; the provider deletes that copy.`
  }
  return `Schedules removal of every copy of ${input.target}${on} that this wallet pays for, in any data set, including data sets other tools created. ${list}`
}

/**
 * `filecoin delete <target>`: schedule removal of the stored copies a ref,
 * PieceCID, root CID, or `<dataSetId>/<pieceId>` names. Destructive, so it
 * needs `--yes` when no human can confirm.
 */
export const remove = defineCommand({
  name: 'delete',
  description: "Schedule removal of a resource's or piece's stored copies",
  examples: [
    'filecoin delete res_abc123',
    'filecoin delete 39723/0 --yes',
    'filecoin delete bafkzcib… --dry-run',
    'filecoin delete bafybei… --provider 9 --yes',
  ],
  input: z.strictObject({
    target: z
      .string()
      .describe(
        'Resource ref (res_…), PieceCID, root CID, or <dataSetId>/<pieceId>'
      ),
    provider: z
      .string()
      .regex(/^\d+$/, 'Expected a decimal provider ID')
      .optional()
      .describe('Only remove the copies on this storage provider'),
    ...account,
  }),
  positionals: ['target'],
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    dryRun: z.boolean(),
    operationId: removeResult.operationId
      .optional()
      .describe('Set when dryRun is false'),
    state: removeResult.state.optional().describe('Set when dryRun is false'),
    target: removeResult.target,
    removals: z.array(removal),
    resources: z
      .array(resource)
      .describe(
        'Managed resources with a copy among the removals; after the delete when dryRun is false'
      ),
  }),
  errors: JOB_ERRORS,
  dryRun: true,
  confirm: confirmReason,
  human: (data) => {
    const live = data.removals.filter((r) =>
      data.dryRun ? r.state === 'live' : r.state === 'scheduled'
    ).length
    return [
      data.dryRun
        ? `Would schedule removal of ${live} cop${live === 1 ? 'y' : 'ies'} of ${data.target}:`
        : `Removal of ${live} cop${live === 1 ? 'y' : 'ies'} of ${data.target} scheduled:`,
      ...formatRemovals(data.removals),
    ].join('\n')
  },
  handler: () => import('../handlers/delete.ts'),
})

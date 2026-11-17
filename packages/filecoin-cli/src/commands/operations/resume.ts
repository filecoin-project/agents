import { defineCommand } from 'clipact'
import * as z from 'zod'
import { JOB_ERRORS } from '../../errors.ts'
import {
  account,
  accountEnv,
  formatRemovals,
  putResult,
  removeResult,
} from '../shared.ts'

/**
 * `filecoin operations resume <id>`: continue an unfinished put or delete with its
 * saved input. Safe to repeat: it reconciles saved submissions before sending
 * anything, and a completed operation returns its saved outcome.
 */
export const resume = defineCommand({
  name: 'resume',
  description: 'Continue an unfinished operation with its saved input',
  examples: ['filecoin operations resume op_abc123'],
  input: z.strictObject({
    id: z.string().describe('Operation ID (op_…)'),
    ...account,
  }),
  positionals: ['id'],
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.discriminatedUnion('state', [
    z.object(putResult),
    z.object(removeResult),
  ]),
  errors: JOB_ERRORS,
  idempotent: true,
  human: (data) =>
    data.state === 'ready'
      ? `Stored ${data.resource.name} (${data.resource.ref})\n${data.urls.browser}`
      : [
          `Removal of ${data.target} scheduled:`,
          ...formatRemovals(data.removals),
        ].join('\n'),
  handler: () => import('../../handlers/operations/resume.ts'),
})

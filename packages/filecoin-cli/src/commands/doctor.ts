import { defineCommand } from 'clipact'
import * as z from 'zod'
import { STORAGE_ERRORS } from '../errors.ts'
import { account, accountEnv } from './shared.ts'

/** A resolved setting and where its value came from. */
const setting = z.object({
  value: z.string(),
  source: z
    .enum(['input', 'env', 'config', 'default'])
    .describe('input means --network or FILECOIN_NETWORK'),
})

/**
 * `filecoin doctor`: resolved settings with their sources, and quick checks of the
 * state database and the RPC endpoint.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md#configuration-and-environment
 */
export const doctor = defineCommand({
  name: 'doctor',
  description: 'Show resolved settings and check the state database and RPC',
  examples: ['filecoin doctor', 'filecoin doctor --network mainnet'],
  input: z.strictObject(account),
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    network: setting,
    rpcUrl: setting,
    consoleUrl: setting,
    apiUrl: setting,
    configFile: z.string(),
    dir: setting
      .extend({
        variable: z
          .string()
          .optional()
          .describe('FILECOIN_CONFIG_DIR, or XDG_DATA_HOME on Linux'),
      })
      .describe('Folder of config.json, state.db, and staged input'),
    credentials: z.enum(['env', 'config', 'pending', 'none']),
    checks: z.array(
      z.object({ name: z.string(), ok: z.boolean(), message: z.string() })
    ),
  }),
  errors: [...STORAGE_ERRORS],
  readOnly: true,
  human: (data) =>
    [
      `network: ${data.network.value} (${data.network.source})`,
      `rpc: ${data.rpcUrl.value} (${data.rpcUrl.source})`,
      `console: ${data.consoleUrl.value} (${data.consoleUrl.source})`,
      `api: ${data.apiUrl.value} (${data.apiUrl.source})`,
      `config: ${data.configFile}`,
      `folder: ${data.dir.value} (${data.dir.variable ?? data.dir.source})`,
      `credentials: ${data.credentials}`,
      ...data.checks.map(
        (check) => `${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.message}`
      ),
    ].join('\n'),
  handler: () => import('../handlers/doctor.ts'),
})

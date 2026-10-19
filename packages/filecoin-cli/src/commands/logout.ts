import { defineCommand } from 'clipact'
import * as z from 'zod'
import { account, accountEnv } from './shared.ts'

/** `filecoin logout`: forget the local session key for a network. */
export const logout = defineCommand({
  name: 'logout',
  description:
    'Forget the local session key (revoke it on-chain in the console)',
  examples: ['filecoin logout', 'filecoin logout --network mainnet'],
  input: z.strictObject({ network: account.network }),
  env: { network: accountEnv.network },
  output: z.object({
    network: z.string(),
    removed: z.boolean(),
    address: z.string().optional().describe('Forgotten session key address'),
    revokeUrl: z
      .string()
      .optional()
      .describe('Console link that revokes the approved key on chain'),
  }),
  idempotent: true,
  human: (data) => {
    if (!data.removed) return `No session key on ${data.network}.`
    const forgot = `Forgot session key ${data.address} on ${data.network}.`
    return data.revokeUrl ? `${forgot}\nrevoke at: ${data.revokeUrl}` : forgot
  },
  handler: () => import('../handlers/logout.ts'),
})

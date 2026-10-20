import { defineCommand } from 'clipact'
import * as z from 'zod'
import { STORAGE_ERRORS } from '../errors.ts'
import { account, accountEnv, formatBytes } from './shared.ts'

/**
 * `filecoin status`: session, scope expiries, wallet and Filecoin Pay
 * balances, runway, stored bytes, and funding readiness.
 */
export const status = defineCommand({
  name: 'status',
  description:
    'Show the session, scope expiries, balances, runway, storage, and funding readiness',
  examples: ['filecoin status', 'filecoin status --network mainnet'],
  input: z.strictObject(account),
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    network: z.string(),
    session: z.object({
      state: z.enum(['none', 'pending', 'active']),
      source: z.enum(['env', 'config']).optional(),
      address: z.string().optional(),
      rootAddress: z.string().optional(),
      url: z.string().optional().describe('Approval link of a pending login'),
      scopes: z
        .record(z.string(), z.string())
        .optional()
        .describe('Expiry per scope, or "expired" or "not granted"'),
    }),
    wallet: z
      .object({
        fil: z.string().describe('FIL in the wallet, which pays gas'),
        usdfc: z.string().describe('USDFC in the wallet, not yet deposited'),
      })
      .optional(),
    account: z
      .object({
        token: z.literal('USDFC'),
        funds: z.string(),
        availableFunds: z.string(),
        debt: z.string(),
        locked: z.string().describe('Funds held for active rails'),
        rateLockup: z
          .string()
          .describe(
            'Part of locked that keeps providers paid for one lockup period after a rail ends; scales with the storage rate'
          ),
        fixedLockup: z
          .string()
          .describe(
            'Part of locked reserved for one-time charges, such as CDN egress'
          ),
        burnRatePerMonth: z
          .string()
          .describe('USDFC spent every 30 days at the current lockup rate'),
        health: z
          .enum(['healthy', 'warning', 'deficit'])
          .describe(
            'deficit: debt or no available funds; warning: 14 days or less left'
          ),
        runwayDays: z
          .number()
          .int()
          .optional()
          .describe('Days until deficit; absent when nothing is being spent'),
        fundedUntil: z
          .string()
          .optional()
          .describe('When the account enters deficit'),
        ready: z.boolean().describe('Ready to pay for a new 1 MiB upload'),
        needsApproval: z.boolean(),
        depositNeeded: z.string(),
        fundingUrl: z.string().optional(),
      })
      .optional(),
    storage: z
      .object({
        dataSets: z.number().int().describe('Live data sets'),
        size: z
          .number()
          .int()
          .describe('Stored bytes, as Warm Storage prices them'),
      })
      .optional(),
  }),
  errors: [...STORAGE_ERRORS],
  readOnly: true,
  human: ({ network, session, wallet, account, storage }) => {
    const lines = [`network: ${network}`, `session: ${session.state}`]
    if (session.url) lines.push(`approve at: ${session.url}`)
    for (const [scope, expiry] of Object.entries(session.scopes ?? {})) {
      lines.push(`  ${scope}: ${expiry}`)
    }
    if (session.rootAddress) lines.push(`wallet: ${session.rootAddress}`)
    if (wallet) lines.push(`  FIL: ${wallet.fil}`, `  USDFC: ${wallet.usdfc}`)
    if (account) {
      const runway =
        account.runwayDays === undefined
          ? 'nothing is being spent'
          : `${account.runwayDays} days left${account.fundedUntil ? `, until ${account.fundedUntil.slice(0, 10)}` : ''}`
      lines.push(
        `health: ${account.health}, ${runway}`,
        `funds: ${account.availableFunds} of ${account.funds} USDFC available`,
        `  locked: ${account.locked} USDFC (rate lockup ${account.rateLockup}, fixed lockup ${account.fixedLockup})`,
        `  burn rate: ${account.burnRatePerMonth} USDFC / month`
      )
      if (account.debt !== '0') lines.push(`  debt: ${account.debt} USDFC`)
    }
    if (storage) {
      lines.push(
        `storage: ${storage.dataSets} data sets, ${formatBytes(storage.size)}`
      )
    }
    if (account) {
      lines.push(`ready: ${account.ready ? 'yes' : 'no'}`)
      if (account.fundingUrl) lines.push(`fund at: ${account.fundingUrl}`)
    }
    return lines.join('\n')
  },
  handler: () => import('../handlers/status.ts'),
})

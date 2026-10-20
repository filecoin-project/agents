import { defineHandler } from 'clipact'
import type { Address } from 'viem'
import { buildRevokeUrl } from '../auth/login.ts'
import { logout } from '../commands/logout.ts'
import { appFor } from './context.ts'

/**
 * Forget the saved session key for the network. An approved key stays valid
 * on chain until it expires, so the result carries the console link that
 * revokes it.
 */
export default defineHandler(logout, async (ctx) => {
  const app = await appFor(ctx)
  const key = `sessions.${app.network}` as const
  const session = app.config.get(key)
  if (session) app.config.delete(key)
  return ctx.ok({
    network: app.network,
    removed: session != null,
    ...(session ? { address: session.address } : {}),
    ...(session?.rootAddress
      ? {
          revokeUrl: buildRevokeUrl({
            consoleUrl: app.consoleUrl,
            address: session.address as Address,
            network: app.network,
          }),
        }
      : {}),
  })
})

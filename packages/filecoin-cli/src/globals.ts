import { defineGlobals } from 'clipact'
import * as z from 'zod'

/** Default Filecoin Pay console origin, which approves keys and funds accounts. */
export const DEFAULT_CONSOLE_URL = 'https://pay.filecoin.cloud'

/** Default filecoin-api origin, whose `/get/{cid}` route redirects to providers. */
export const DEFAULT_API_URL = 'https://api.filecoin.io'

/**
 * Settings every command reads only from the environment. Root help lists
 * them under Environment and `schema --list` under `globals`. Like the command
 * definitions, this module loads only zod and clipact.
 *
 * @see https://github.com/hugomrdias/agents/tree/main/packages/clipact#globals
 */
export const globals = defineGlobals({
  input: z.object({
    rpcUrl: z
      .url()
      .optional()
      .describe("RPC endpoint (default: the chain's fallback transport)"),
    consoleUrl: z
      .url()
      .default(DEFAULT_CONSOLE_URL)
      .describe(
        'Filecoin Pay console origin for approval, funding, revoke, and console home links'
      ),
    apiUrl: z
      .url()
      .default(DEFAULT_API_URL)
      .describe('filecoin-api origin for retrieval links'),
  }),
  env: {
    rpcUrl: 'FILECOIN_RPC_URL',
    consoleUrl: 'FILECOIN_CONSOLE_URL',
    apiUrl: 'FILECOIN_API_URL',
  },
})

/** Validated values of {@link globals}. */
export type GlobalSettings = ReturnType<typeof globals.get>

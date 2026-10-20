import { defineCli } from 'clipact'
import pkg from '../package.json' with { type: 'json' }
import { commands } from './commands/index.ts'
import { errors } from './errors.ts'

/**
 * The `filecoin` CLI. This module and the definitions it imports load only zod and
 * clipact, so `--help`, `--version`, and `schema` never load an SDK; each
 * handler is imported when its command runs.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md
 * @see ../../../docs/filecoin/interface-research.md
 */
export const cli = defineCli({
  name: 'filecoin',
  version: pkg.version,
  description: 'Store files and folders on Filecoin and get retrieval links',
  envPrefix: 'FIL',
  commands,
  skills: new URL('../skills/', import.meta.url),
  mapError: () => import('./map-error.ts'),
  errors,
})

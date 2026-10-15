/**
 * Generates `src/schema.ts` from filecoin-api's committed `openapi.json` with
 * openapi-typescript. With `--check`, exits with an error instead of writing
 * when `src/schema.ts` is out of date.
 *
 * openapi-typescript runs through `pnpm dlx` with TypeScript 5, because it
 * prints with the TypeScript 5 compiler API, which the repository's
 * TypeScript 7 does not have.
 *
 * @see https://openapi-ts.dev/cli
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const SPEC = new URL('../../../apps/filecoin-api/openapi.json', import.meta.url)
const OUTPUT = new URL('../src/schema.ts', import.meta.url)

const { values } = parseArgs({ options: { check: { type: 'boolean' } } })

const schema = execFileSync(
  'pnpm',
  [
    'dlx',
    '--package',
    'openapi-typescript@7.13.0',
    '--package',
    'typescript@5.9.3',
    'openapi-typescript',
    fileURLToPath(SPEC),
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
)

if (!values.check) {
  await writeFile(OUTPUT, schema)
} else if ((await readFile(OUTPUT, 'utf8')) !== schema) {
  process.stderr.write(
    'src/schema.ts is out of date with apps/filecoin-api/openapi.json. Run `pnpm gen` in packages/filecoin-api-client.\n'
  )
  process.exitCode = 1
}

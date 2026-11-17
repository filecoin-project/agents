/**
 * Generates `src/schema.ts` from filecoin-api's committed `openapi.json` with
 * openapi-typescript. With `--check`, exits with an error instead of writing
 * when `src/schema.ts` is out of date.
 *
 * openapi-typescript prints with the TypeScript 5 compiler API, which the
 * repository's TypeScript 7 does not have. The private `generator` package
 * locks it with TypeScript 5, so this script runs the CLI from there.
 *
 * @see https://openapi-ts.dev/cli
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const SPEC = new URL('../../../apps/filecoin-api/openapi.json', import.meta.url)
const OUTPUT = new URL('../src/schema.ts', import.meta.url)
const GENERATOR = new URL('../generator/package.json', import.meta.url)

const { values } = parseArgs({ options: { check: { type: 'boolean' } } })

/**
 * Finds openapi-typescript's CLI as the `generator` package resolves it.
 *
 * @see https://nodejs.org/api/module.html#modulecreaterequirefilename
 */
function resolveCli(): string {
  const require = createRequire(GENERATOR)
  const manifestPath = require.resolve('openapi-typescript/package.json')
  const manifest = require(manifestPath) as { bin: Record<string, string> }
  return join(dirname(manifestPath), manifest.bin['openapi-typescript'])
}

const schema = execFileSync(
  process.execPath,
  [resolveCli(), fileURLToPath(SPEC)],
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

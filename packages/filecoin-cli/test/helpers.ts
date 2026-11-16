import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { after } from 'node:test'
import { Conf } from 'iso-conf'
import { ConfigSchema } from '../src/config.ts'
import type { DfsCar } from '../src/storage/dfs-car.ts'

/**
 * Create a temporary directory removed after the current test file.
 */
export async function tempDir(prefix = 'filecoin-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Open the `config.json` that the CLI's store reads in the folder `dir`
 * (`FILECOIN_CONFIG_DIR`), the way clipact opens it, to seed or check it.
 *
 * @see https://github.com/hugomrdias/agents/tree/main/packages/clipact#storage
 */
export function openConfig(dir: string) {
  return new Conf({ cwd: dir, configName: 'config', schema: ConfigSchema })
}

/** Write a planned CAR to `path` and return its bytes. */
export async function writeCar(car: DfsCar, path: string): Promise<Buffer> {
  await pipeline(Readable.from(car.stream()), createWriteStream(path))
  return await readFile(path)
}

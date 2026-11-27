import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { after } from 'node:test'
import { Conf } from 'iso-conf'
import { ConfigSchema } from '../src/config.ts'
import { type DownloadDagResult, downloadDag } from '../src/storage/dag.ts'
import { type DfsCar, planDirectory, planFile } from '../src/storage/dfs-car.ts'
import { carFetch } from './dfs-car.ts'

/**
 * Test options that skip fixtures Windows cannot create: a FIFO, a socket
 * path, or a name with a backslash.
 *
 * @see https://nodejs.org/api/test.html#testname-options-fn
 */
export const POSIX_ONLY = { skip: process.platform === 'win32' }

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

/** Plan the folder `dir`, write its CAR to `carPath`, and return the plan. */
export async function packDirectory(
  dir: string,
  carPath: string
): Promise<DfsCar> {
  const car = await planDirectory(dir)
  await writeCar(car, carPath)
  return car
}

/** Plan the file `file`, write its CAR to `carPath`, and return the plan. */
export async function packFile(file: string, carPath: string): Promise<DfsCar> {
  const car = await planFile(file)
  await writeCar(car, carPath)
  return car
}

/**
 * Extract the CAR at `carPath` into `output` with `get`'s `downloadDag`,
 * serving its bytes as they are, the way `/piece` returns a piece written by
 * `put`: a depth-first CAR that sends each block once (`dups=n`).
 */
export function extractCar(
  carPath: string,
  rootCid: string,
  output: string
): Promise<DownloadDagResult> {
  return downloadDag({
    url: 'https://sp.example/piece/car',
    rootCid,
    output,
    fetch: carFetch(() => createReadStream(carPath), {
      contentType: 'application/vnd.ipld.car;version=1;order=dfs;dups=n',
    }),
  })
}

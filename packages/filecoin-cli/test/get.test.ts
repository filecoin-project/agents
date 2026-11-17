/**
 * Runs `filecoin get` in process against providers and filecoin-api mocked
 * with msw, which intercepts `globalThis.fetch`. Unmocked requests fail the
 * test, so every case also proves where `get` downloads from.
 *
 * @see https://mswjs.io/docs/api/setup-server
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import * as Piece from '@filoz/synapse-core/piece'
import { assertContract, invoke } from 'clipact/testing'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { CID } from 'multiformats/cid'
import { cli } from '../src/cli.ts'
import { openDatabase } from '../src/state/db.ts'
import { saveResource } from '../src/state/resources.ts'
import { DFS_CAR_ACCEPT } from '../src/storage/dag.ts'
import { carStream, dfsBlocks } from './dfs-car.ts'
import { packDirectory } from './helpers.ts'

const API = 'http://api.test'
const SP = 'http://sp.test/base'
const SESSION_KEY = `0x${'11'.repeat(32)}`
const ROOT = '0x1111111111111111111111111111111111111111'
const CALIBRATION = '314159'

/** Environment of every run: the folder, the API, and CI credentials. */
const env: Record<string, string> = {
  FILECOIN_API_URL: API,
  FILECOIN_SESSION_KEY: SESSION_KEY,
  FILECOIN_ROOT_ADDRESS: ROOT,
}

const server = setupServer()

/** A packed folder: its source, CAR bytes, root CID and PieceCID. */
type Packed = {
  dir: string
  car: string
  bytes: Uint8Array
  rootCid: string
  pieceCid: string
}
let site: Packed
let work: string

/** Create and pack a folder named `name` with a multi-chunk file. */
async function pack(name: string): Promise<Packed> {
  const dir = join(work, name)
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), `<h1>${name}</h1>`)
  await writeFile(join(dir, 'assets', 'big.bin'), randomBytes(1_500_000))
  const car = join(work, `${name}.car`)
  const { rootCid } = await packDirectory(dir, car)
  const bytes = new Uint8Array(await readFile(car))
  const hasher = Piece.hasher()
  hasher.write(bytes)
  return {
    dir,
    car,
    bytes,
    rootCid: rootCid.toString(),
    pieceCid: hasher.finalize().toString(),
  }
}

before(async () => {
  // Not tempDir(): its cleanup would run when this hook ends.
  work = await mkdtemp(join(tmpdir(), 'filecoin-get-'))
  env.FILECOIN_CONFIG_DIR = join(work, 'filecoin')
  site = await pack('site')
  const { bytes } = site
  const db = openDatabase(env.FILECOIN_CONFIG_DIR)
  saveResource(db, {
    ref: 'res_site',
    kind: 'folder',
    name: 'site',
    chainId: CALIBRATION,
    payer: ROOT,
    pieceCid: site.pieceCid,
    rootCid: site.rootCid,
    size: bytes.length,
    copies: [{ providerId: '9', dataSetId: '1', pieceId: '0', serviceURL: SP }],
    status: 'active',
    createdAt: '2026-11-16T00:00:00.000Z',
  })
  db.close()
  server.listen({ onUnhandledFrame: 'error' })
})
afterEach(() => server.resetHandlers())
after(async () => {
  server.close()
  await rm(work, { recursive: true, force: true })
})

/** Runs the CLI in process and returns the contract-checked JSON result. */
async function run(args: string[]): Promise<Record<string, unknown>> {
  return assertContract(await invoke(cli, args, { env }))
}

/** Serve a folder's DAG at `/ipfs/{rootCid}` and its CAR at `/piece/{pieceCid}`. */
function provider(seen: string[], packed: Packed = site) {
  return [
    http.get(`${SP}/ipfs/:cid`, async ({ request, params }) => {
      seen.push(`ipfs ${request.headers.get('accept')}`)
      if (params.cid !== packed.rootCid) {
        return new HttpResponse(null, { status: 404 })
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of carStream(
        CID.parse(packed.rootCid),
        dfsBlocks(packed.car)
      )) {
        chunks.push(chunk)
      }
      return new HttpResponse(new Blob(chunks as BlobPart[]), {
        headers: { 'content-type': DFS_CAR_ACCEPT },
      })
    }),
    http.get(`${SP}/piece/:cid`, ({ params }) => {
      seen.push('piece')
      if (params.cid !== packed.pieceCid) {
        return new HttpResponse(null, { status: 404 })
      }
      return new HttpResponse(packed.bytes)
    }),
  ]
}

test('get <ref> of a folder streams its root from the provider /ipfs', async () => {
  const seen: string[] = []
  server.use(...provider(seen))
  const output = join(work, 'by-ref')
  const result = await run(['get', 'res_site', '--output', output])
  assert.ok(result.data, JSON.stringify(result))
  const data = result.data as Record<string, unknown>
  assert.equal(data.kind, 'folder')
  assert.equal(data.rootCid, site.rootCid)
  assert.equal(data.pieceCid, site.pieceCid)
  assert.equal(data.files, 2)
  assert.equal(data.url, `${SP}/ipfs/${site.rootCid}`)
  assert.deepEqual(seen, [`ipfs ${DFS_CAR_ACCEPT}`])
  assert.deepEqual(
    await readFile(join(output, 'assets', 'big.bin')),
    await readFile(join(site.dir, 'assets', 'big.bin'))
  )
})

test('get <rootCid> of a managed folder uses its saved provider', async () => {
  const seen: string[] = []
  server.use(...provider(seen))
  const output = join(work, 'by-root')
  const result = await run(['get', site.rootCid, '--output', output])
  assert.ok(result.data, JSON.stringify(result))
  assert.equal((result.data as { kind: string }).kind, 'folder')
  assert.deepEqual(seen, [`ipfs ${DFS_CAR_ACCEPT}`])
})

test('get <pieceCid> of a managed folder writes the stored CAR', async () => {
  const seen: string[] = []
  server.use(...provider(seen))
  const output = join(work, 'by-piece.car')
  const result = await run(['get', site.pieceCid, '--output', output])
  assert.ok(result.data, JSON.stringify(result))
  const data = result.data as Record<string, unknown>
  assert.equal(data.kind, 'file')
  assert.equal(data.ref, 'res_site')
  assert.equal(data.rootCid, undefined)
  assert.equal(data.size, site.bytes.length)
  assert.deepEqual(seen, ['piece'])
  assert.deepEqual(new Uint8Array(await readFile(output)), site.bytes)
})

test('get <ref> reports a root Curio has not indexed as retryable', async () => {
  server.use(
    http.get(`${SP}/ipfs/:cid`, () => new HttpResponse(null, { status: 404 }))
  )
  const result = await run(['get', 'res_site', '--output', join(work, 'nope')])
  assert.ok(result.error, JSON.stringify(result))
  const error = result.error as Record<string, unknown>
  assert.equal(error.code, 'not_found')
  assert.equal(error.retryable, true)
  assert.equal(error.retryAfterSeconds, 60)
  const next = result.next as { command?: string }[]
  assert.ok(
    next.some((step) => step.command === `filecoin get ${site.pieceCid}`)
  )
})

test('get <CID> outside local state resolves through filecoin-api', async () => {
  const other = await pack('other')
  const { rootCid } = other
  const seen: string[] = []
  server.use(
    ...provider(seen, other),
    http.get(`${API}/get/:cid`, ({ request, params }) => {
      const url = new URL(request.url)
      seen.push(`api ${params.cid} ${url.searchParams.get('network')}`)
      const kind = params.cid === other.pieceCid ? 'piece' : 'ipfs'
      return HttpResponse.redirect(`${SP}/${kind}/${params.cid}`, 302)
    })
  )
  const output = join(work, 'unmanaged')
  const result = await run(['get', rootCid, '--output', output])
  assert.ok(result.data, JSON.stringify(result))
  const data = result.data as Record<string, unknown>
  assert.equal(data.kind, 'folder')
  assert.equal(data.rootCid, rootCid)
  assert.equal(data.ref, undefined)
  assert.deepEqual(seen, [
    `api ${rootCid} calibration`,
    `ipfs ${DFS_CAR_ACCEPT}`,
  ])

  seen.length = 0
  const pieceOutput = join(work, 'unmanaged.car')
  const piece = await run(['get', other.pieceCid, '--output', pieceOutput])
  assert.ok(piece.data, JSON.stringify(piece))
  assert.deepEqual(seen, [`api ${other.pieceCid} calibration`, 'piece'])
  assert.deepEqual(new Uint8Array(await readFile(pieceOutput)), other.bytes)
})

test('get <unknown CID> is not_found when filecoin-api has no provider', async () => {
  server.use(
    http.get(`${API}/get/:cid`, () =>
      HttpResponse.json({ error: 'not found' }, { status: 404 })
    )
  )
  const cid = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  const result = await run(['get', cid, '--output', join(work, 'missing')])
  assert.ok(result.error, JSON.stringify(result))
  assert.equal((result.error as { code: string }).code, 'not_found')
})

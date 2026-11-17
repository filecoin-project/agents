/**
 * Runs `filecoin inspect` in process against filecoin-api responses mocked
 * with msw, which intercepts `globalThis.fetch`. Unmocked requests fail the
 * test, so every case also proves which requests the command sends.
 *
 * @see https://mswjs.io/docs/api/setup-server
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import type {
  Piece as ApiPiece,
  DataSet,
  PieceWithDataSet,
} from '@filecoin-project/api-client'
import * as Piece from '@filoz/synapse-core/piece'
import { assertContract, invoke } from 'clipact/testing'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { cli } from '../src/cli.ts'
import { openDatabase } from '../src/state/db.ts'
import { type Resource, saveResource } from '../src/state/resources.ts'
import { tempDir } from './helpers.ts'

const API = 'http://api.test'
const SESSION_KEY = `0x${'11'.repeat(32)}`
const ROOT = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const CALIBRATION = '314159'

/** Environment of every run: the folder, the API, and CI credentials. */
const env: Record<string, string> = {
  FILECOIN_API_URL: API,
  FILECOIN_SESSION_KEY: SESSION_KEY,
  FILECOIN_ROOT_ADDRESS: ROOT,
}

const server = setupServer()

before(async () => {
  env.FILECOIN_CONFIG_DIR = join(await tempDir(), 'filecoin')
  server.listen({ onUnhandledFrame: 'error' })
})
afterEach(() => server.resetHandlers())
after(() => server.close())

/** Runs the CLI in process and returns the contract-checked JSON result. */
async function run(args: string[]): Promise<Record<string, unknown>> {
  return assertContract(await invoke(cli, args, { env }))
}

/** The PieceCID of `text`, so `Piece.tryFrom` accepts it. */
function pieceCidOf(text: string): string {
  const hasher = Piece.hasher()
  hasher.write(new TextEncoder().encode(text.repeat(64)))
  return hasher.finalize().toString()
}

/** A CIDv1 of `text` that is not a PieceCID, standing in for a root. */
async function rootCidOf(text: string): Promise<CID> {
  return CID.create(
    1,
    raw.code,
    await sha256.digest(new TextEncoder().encode(text))
  )
}

/** Save a folder resource in local state with one copy. */
function saveFolder(
  ref: string,
  pieceCid: string,
  rootCid: string,
  dataSetId: string,
  pieceId: string
): Resource {
  const resource: Resource = {
    ref,
    kind: 'folder',
    name: 'site',
    chainId: CALIBRATION,
    payer: ROOT,
    pieceCid,
    rootCid,
    size: 2048,
    copies: [
      {
        providerId: '9',
        dataSetId,
        pieceId,
        serviceURL: 'https://calib.ezpdpz.net',
      },
    ],
    status: 'active',
    createdAt: '2026-11-13T00:00:00.000Z',
  }
  const db = openDatabase(env.FILECOIN_CONFIG_DIR as string)
  saveResource(db, resource)
  db.close()
  return resource
}

/** A filecoin-api piece with its data set's owner and provider. */
function apiPiece(
  dataSetId: string,
  pieceId: string,
  overrides: Partial<PieceWithDataSet> = {}
): PieceWithDataSet {
  return {
    dataSetId,
    pieceId,
    cid: null,
    rawSize: '2048',
    metadata: null,
    removed: false,
    addedAtBlock: '3000002',
    removedAtBlock: null,
    updatedAtBlock: '3000002',
    owner: ROOT,
    providerId: '9',
    ...overrides,
  }
}

/** Answer `/pieces` with `data` and record each request's query. */
function mockPieces(data: PieceWithDataSet[]): Record<string, string>[] {
  const seen: Record<string, string>[] = []
  server.use(
    http.get(`${API}/calibration/pieces`, ({ request }) => {
      seen.push(Object.fromEntries(new URL(request.url).searchParams))
      return HttpResponse.json({ data, nextCursor: null })
    })
  )
  return seen
}

/** filecoin-api `/get` URL of `cid`. */
const getUrl = (cid: string, browser = false) =>
  `${API}/get/${cid}?network=calibration${browser ? '&browser=true' : ''}`

test('inspect <ref> shows the resource and every indexed piece with its PieceCID', async () => {
  const pieceCid = pieceCidOf('site')
  const rootCid = (await rootCidOf('site')).toString()
  const resource = saveFolder('res_site', pieceCid, rootCid, '100', '0')
  const metadata = { name: 'site', ipfsRootCID: rootCid }
  const seen = mockPieces([
    apiPiece('101', '4', { cid: pieceCid, metadata }),
    apiPiece('100', '0', { cid: pieceCid, metadata, removed: true }),
  ])
  const json = await run(['inspect', 'res_site'])
  assert.deepEqual(seen, [{ owner: ROOT, limit: '200', cid: pieceCid }])
  const piece = (dataSetId: string, pieceId: string, removed: boolean) => ({
    dataSetId,
    pieceId,
    providerId: '9',
    pieceCid,
    rootCid,
    name: 'site',
    rawSize: '2048',
    metadata,
    removed,
    addedAtBlock: '3000002',
    url: getUrl(rootCid, true),
  })
  assert.deepEqual(json, {
    data: {
      network: 'calibration',
      resource,
      pieces: [
        piece('101', '4', false),
        { ...piece('100', '0', true), resourceRef: 'res_site' },
      ],
      urls: { piece: getUrl(pieceCid), browser: getUrl(rootCid, true) },
    },
  })
})

test('inspect <ref> before the indexer has the put shows no pieces', async () => {
  const pieceCid = pieceCidOf('fresh')
  const rootCid = (await rootCidOf('fresh')).toString()
  saveFolder('res_fresh', pieceCid, rootCid, '110', '0')
  mockPieces([])
  const json = await run(['inspect', 'res_fresh'])
  const data = json.data as { resource: Resource; pieces: unknown[] }
  assert.equal(data.resource.ref, 'res_fresh')
  assert.deepEqual(data.pieces, [])

  const human = await invoke(cli, ['inspect', 'res_fresh'], {
    env,
    tty: true,
  })
  assert.match(human.stdout, /pieces: not indexed yet/)
})

test('inspect <dataSetId>/<pieceId> reads the piece and its data set', async () => {
  const pieceCid = pieceCidOf('pair')
  const rootCid = (await rootCidOf('pair')).toString()
  const resource = saveFolder('res_pair', pieceCid, rootCid, '120', '3')
  const piece: ApiPiece = {
    dataSetId: '120',
    pieceId: '3',
    cid: pieceCid,
    rawSize: '2048',
    metadata: { name: 'site', ipfsRootCID: rootCid },
    removed: false,
    addedAtBlock: '3000002',
    removedAtBlock: null,
    updatedAtBlock: '3000002',
  }
  let owner = ROOT
  server.use(
    http.get(`${API}/calibration/data-sets/120/pieces/3`, () =>
      HttpResponse.json({ data: piece })
    ),
    http.get(`${API}/calibration/data-sets/120`, () =>
      HttpResponse.json({
        data: { dataSetId: '120', owner, providerId: '9' } as DataSet,
      })
    )
  )
  const json = await run(['inspect', '120/3'])
  const data = json.data as {
    resource: Resource
    pieces: { providerId: string; resourceRef: string }[]
    urls: unknown
  }
  assert.deepEqual(data.resource, resource)
  assert.equal(data.pieces[0]?.providerId, '9')
  assert.equal(data.pieces[0]?.resourceRef, 'res_pair')
  assert.deepEqual(data.urls, {
    piece: getUrl(pieceCid),
    browser: getUrl(rootCid, true),
  })

  owner = OTHER
  const foreign = await run(['inspect', '120/3'])
  assert.equal((foreign.error as { code: string }).code, 'not_found')
  assert.deepEqual(foreign.next, [
    {
      by: 'agent',
      command: 'filecoin inspect res_pair',
      description: 'Inspect the managed resource stored as this piece',
    },
  ])
})

test('inspect <pieceCid> of a piece stored elsewhere has no resource', async () => {
  const pieceCid = pieceCidOf('elsewhere')
  const seen = mockPieces([
    apiPiece('130', '1', { cid: pieceCid, metadata: { name: 'notes.txt' } }),
  ])
  const json = await run(['inspect', pieceCid])
  assert.deepEqual(seen, [{ owner: ROOT, limit: '200', cid: pieceCid }])
  const data = json.data as Record<string, unknown>
  assert.equal(data.resource, undefined)
  assert.equal((data.pieces as unknown[]).length, 1)
  assert.deepEqual(data.urls, {
    piece: getUrl(pieceCid),
    browser: getUrl(pieceCid, true),
  })
})

test('inspect <rootCid> searches the ipfsRootCID metadata in CIDv1', async () => {
  const root = await rootCidOf('root')
  const [a, b] = [pieceCidOf('root-a'), pieceCidOf('root-b')]
  const metadata = { ipfsRootCID: root.toString() }
  const seen = mockPieces([
    apiPiece('140', '0', { cid: a, metadata }),
    apiPiece('141', '0', { cid: a, metadata }),
  ])
  const json = await run(['inspect', root.toV1().toString()])
  assert.deepEqual(seen, [
    { owner: ROOT, limit: '200', ipfs_cid: root.toString() },
  ])
  assert.deepEqual((json.data as { urls: unknown }).urls, {
    piece: getUrl(a),
    browser: getUrl(root.toString(), true),
  })

  mockPieces([
    apiPiece('140', '0', { cid: a, metadata }),
    apiPiece('142', '0', { cid: b, metadata }),
  ])
  const ambiguous = await run(['inspect', root.toString()])
  assert.equal((ambiguous.error as { code: string }).code, 'invalid_input')
  assert.deepEqual(
    (ambiguous.next as { command: string }[]).map((n) => n.command),
    [`filecoin inspect ${a}`, `filecoin inspect ${b}`]
  )
})

test('inspect of a CID no piece matches is not_found', async () => {
  mockPieces([])
  const json = await run(['inspect', pieceCidOf('missing')])
  assert.equal((json.error as { code: string }).code, 'not_found')
  assert.match((json.error as { message: string }).message, /a few minutes/)
  assert.deepEqual(json.next, [
    {
      by: 'agent',
      command: 'filecoin ls',
      description: "List the wallet's stored pieces",
    },
  ])
})

test('inspect rejects a target that names nothing', async () => {
  const json = await run(['inspect', 'not-a-cid'])
  assert.equal((json.error as { code: string }).code, 'invalid_input')
})

test('inspect --check probes the piece URL of any target', async () => {
  const pieceCid = pieceCidOf('check')
  mockPieces([apiPiece('150', '0', { cid: pieceCid })])
  const probed: string[] = []
  server.use(
    http.head(`${API}/get/:cid`, ({ request }) => {
      probed.push(request.url)
      return new HttpResponse(null, { status: 200 })
    })
  )
  const json = await run(['inspect', pieceCid, '--check'])
  const retrieval = (json.data as { retrieval: Record<string, unknown> })
    .retrieval
  assert.deepEqual(probed, [getUrl(pieceCid)])
  assert.equal(retrieval.state, 'ready')
  assert.equal(retrieval.status, 200)
})

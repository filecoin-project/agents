/**
 * Runs `filecoin datasets` in process against filecoin-api responses mocked
 * with msw, which intercepts `globalThis.fetch`. Unmocked requests fail the
 * test, so every case also proves which requests a command sends.
 *
 * @see https://mswjs.io/docs/api/setup-server
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import type { DataSet, Piece, Provider } from '@filecoin-project/api-client'
import { assertContract, invoke } from 'clipact/testing'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { cli } from '../src/cli.ts'
import { openDatabase } from '../src/state/db.ts'
import { saveResource } from '../src/state/resources.ts'
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
async function run(
  args: string[],
  extra: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  return assertContract(await invoke(cli, args, { env: { ...env, ...extra } }))
}

/** A filecoin-api data set with the indexer's nulls where it has no value. */
function apiDataSet(overrides: Partial<DataSet> = {}): DataSet {
  return {
    dataSetId: '39723',
    providerId: '9',
    owner: ROOT,
    source: 'filecoin-cli',
    metadata: { source: 'filecoin-cli', withIPFSIndexing: '' },
    withCdn: false,
    withIpfsIndexing: true,
    pdpEndEpoch: '0',
    pdpRailId: '120',
    cacheMissRailId: null,
    cdnRailId: null,
    deleted: false,
    createdAtBlock: '3000000',
    updatedAtBlock: '3000001',
    ...overrides,
  }
}

/** A filecoin-api piece. */
function apiPiece(pieceId: string, overrides: Partial<Piece> = {}): Piece {
  return {
    dataSetId: '39723',
    pieceId,
    cid: `bafkzcibpiece${pieceId}`,
    rawSize: '2048',
    metadata: null,
    removed: false,
    addedAtBlock: '3000002',
    removedAtBlock: null,
    updatedAtBlock: '3000002',
    ...overrides,
  }
}

/** A filecoin-api provider. */
const provider: Provider = {
  providerId: '9',
  address: '0x9999999999999999999999999999999999999999',
  name: 'ezpdpz-calib',
  serviceUrl: 'https://calib.ezpdpz.net',
  active: true,
  pdpProductActive: true,
  approved: true,
  endorsed: false,
  createdAtBlock: '1',
  updatedAtBlock: '1',
} as Provider

/** Mocks the data set, piece, and provider routes of one data set. */
function mockDataSet(dataSet: DataSet, pieces: Piece[], seen: URL[] = []) {
  server.use(
    http.get(`${API}/calibration/data-sets/${dataSet.dataSetId}`, () =>
      HttpResponse.json({ data: dataSet })
    ),
    http.get(
      `${API}/calibration/data-sets/${dataSet.dataSetId}/pieces`,
      ({ request }) => {
        seen.push(new URL(request.url))
        return HttpResponse.json({ data: pieces, nextCursor: 'p2' })
      }
    ),
    http.get(`${API}/calibration/providers/9`, () =>
      HttpResponse.json({ data: provider })
    )
  )
}

test("datasets ls asks filecoin-api for the payer's live data sets", async () => {
  const seen: URL[] = []
  server.use(
    http.get(`${API}/calibration/data-sets`, ({ request }) => {
      seen.push(new URL(request.url))
      return HttpResponse.json({
        data: [
          apiDataSet(),
          apiDataSet({
            dataSetId: '39700',
            providerId: null,
            source: null,
            metadata: null,
            withIpfsIndexing: false,
            pdpEndEpoch: '3100000',
          }),
        ],
        nextCursor: 'next-page',
      })
    })
  )
  const json = await run(['datasets', 'ls', '--limit', '2'])
  assert.deepEqual(
    Object.fromEntries(seen[0]?.searchParams ?? []),
    { owner: ROOT, limit: '2', deleted: 'false' },
    'query'
  )
  assert.deepEqual(json, {
    data: {
      network: 'calibration',
      dataSets: [
        {
          dataSetId: '39723',
          providerId: '9',
          source: 'filecoin-cli',
          withIpfsIndexing: true,
          withCdn: false,
          metadata: { source: 'filecoin-cli', withIPFSIndexing: '' },
          pdpRailId: '120',
          deleted: false,
          createdAtBlock: '3000000',
        },
        {
          dataSetId: '39700',
          withIpfsIndexing: false,
          withCdn: false,
          metadata: {},
          pdpRailId: '120',
          pdpEndEpoch: '3100000',
          deleted: false,
          createdAtBlock: '3000000',
        },
      ],
      nextCursor: 'next-page',
    },
  })
})

test('datasets ls passes --provider, --cursor, and --all through', async () => {
  const seen: URL[] = []
  server.use(
    http.get(`${API}/calibration/data-sets`, ({ request }) => {
      seen.push(new URL(request.url))
      return HttpResponse.json({ data: [], nextCursor: null })
    })
  )
  const json = await run([
    'datasets',
    'ls',
    '--provider',
    '9',
    '--cursor',
    'abc',
    '--all',
  ])
  assert.deepEqual(Object.fromEntries(seen[0]?.searchParams ?? []), {
    owner: ROOT,
    limit: '20',
    cursor: 'abc',
    provider_id: '9',
  })
  assert.deepEqual(json, { data: { network: 'calibration', dataSets: [] } })
})

test('datasets inspect links pieces to managed resources', async () => {
  const db = openDatabase(env.FILECOIN_CONFIG_DIR as string)
  saveResource(db, {
    ref: 'res_site',
    kind: 'folder',
    name: 'site',
    chainId: CALIBRATION,
    payer: ROOT,
    pieceCid: 'bafkzcibpiece0',
    rootCid: 'bafyroot',
    size: 2048,
    copies: [
      {
        providerId: '9',
        dataSetId: '39723',
        pieceId: '0',
        serviceURL: 'https://calib.ezpdpz.net',
      },
    ],
    status: 'active',
    createdAt: '2026-11-13T00:00:00.000Z',
  })
  db.close()
  const seen: URL[] = []
  mockDataSet(apiDataSet(), [apiPiece('0'), apiPiece('1')], seen)
  const json = await run(['datasets', 'inspect', '39723', '--limit', '2'])
  assert.deepEqual(Object.fromEntries(seen[0]?.searchParams ?? []), {
    limit: '2',
    removed: 'false',
  })
  const data = json.data as Record<string, unknown>
  assert.deepEqual(data.provider, {
    providerId: '9',
    name: 'ezpdpz-calib',
    serviceURL: 'https://calib.ezpdpz.net',
  })
  assert.equal((data.dataSet as Record<string, unknown>).pdpEndEpoch, undefined)
  assert.deepEqual(data.pieces, [
    {
      pieceId: '0',
      pieceCid: 'bafkzcibpiece0',
      rawSize: '2048',
      metadata: {},
      removed: false,
      addedAtBlock: '3000002',
      resourceRef: 'res_site',
    },
    {
      pieceId: '1',
      pieceCid: 'bafkzcibpiece1',
      rawSize: '2048',
      metadata: {},
      removed: false,
      addedAtBlock: '3000002',
    },
  ])
  assert.equal(data.nextCursor, 'p2')
})

test('datasets inspect --removed asks for removed pieces too', async () => {
  const seen: URL[] = []
  mockDataSet(apiDataSet(), [], seen)
  await run(['datasets', 'inspect', '39723', '--removed'])
  assert.equal(seen[0]?.searchParams.has('removed'), false)
})

test('datasets inspect of an unknown or foreign data set is not_found', async () => {
  server.use(
    http.get(`${API}/calibration/data-sets/1`, () =>
      HttpResponse.json(
        { error: { code: 'not_found', message: 'Data set 1 not found' } },
        { status: 404 }
      )
    ),
    http.get(`${API}/calibration/data-sets/1/pieces`, () =>
      HttpResponse.json({ data: [], nextCursor: null })
    )
  )
  const missing = await run(['datasets', 'inspect', '1'])
  assert.equal((missing.error as { code: string }).code, 'not_found')
  assert.deepEqual(missing.next, [
    {
      by: 'agent',
      command: 'filecoin datasets ls',
      description: "List the wallet's data sets",
    },
  ])

  mockDataSet(apiDataSet({ owner: OTHER }), [])
  const foreign = await run(['datasets', 'inspect', '39723'])
  assert.equal((foreign.error as { code: string }).code, 'not_found')
})

test('filecoin-api rate limits and outages are retryable', async () => {
  for (const [status, expected] of [
    [429, 'rate_limited'],
    [503, 'service_unavailable'],
  ] as const) {
    server.use(
      http.get(`${API}/calibration/data-sets`, () =>
        HttpResponse.json(
          { error: { code: 'unavailable', message: 'try later' } },
          { status }
        )
      )
    )
    const json = await run(['datasets', 'ls'])
    const error = json.error as { code: string; retryable: boolean }
    assert.equal(error.code, expected, `HTTP ${status}`)
    assert.equal(error.retryable, true, `HTTP ${status}`)
  }
})

test('an unreachable filecoin-api is service_unavailable', async () => {
  server.use(
    http.get(`${API}/calibration/data-sets`, () => HttpResponse.error())
  )
  const json = await run(['datasets', 'ls'])
  assert.equal((json.error as { code: string }).code, 'service_unavailable')
})

test('datasets commands need a session before any request', async () => {
  const json = await run(['datasets', 'ls'], {
    FILECOIN_SESSION_KEY: '',
    FILECOIN_ROOT_ADDRESS: '',
  })
  assert.equal((json.error as { code: string }).code, 'auth_required')
})

/**
 * Runs `filecoin ls` in process against filecoin-api responses mocked with
 * msw, which intercepts `globalThis.fetch`. Unmocked requests fail the test,
 * so every case also proves which requests the command sends.
 *
 * @see https://mswjs.io/docs/api/setup-server
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import type { PieceWithDataSet } from '@filecoin-project/api-client'
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

/** A filecoin-api piece with its data set's owner and provider. */
function apiPiece(
  dataSetId: string,
  pieceId: string,
  overrides: Partial<PieceWithDataSet> = {}
): PieceWithDataSet {
  return {
    dataSetId,
    pieceId,
    cid: `bafkzcibpiece${dataSetId}x${pieceId}`,
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

test("ls asks filecoin-api for the payer's live pieces and links local refs", async () => {
  const db = openDatabase(env.FILECOIN_CONFIG_DIR as string)
  saveResource(db, {
    ref: 'res_site',
    kind: 'folder',
    name: 'site',
    chainId: CALIBRATION,
    payer: ROOT,
    pieceCid: 'bafkzcibpiece39723x0',
    rootCid: 'bafyroot',
    size: 2048,
    copies: [
      {
        providerId: '9',
        dataSetId: '39723',
        pieceId: '0',
        serviceURL: 'https://calib.ezpdpz.net',
      },
      {
        providerId: '4',
        dataSetId: '39724',
        pieceId: '5',
        serviceURL: 'https://other.example',
      },
    ],
    status: 'active',
    createdAt: '2026-11-13T00:00:00.000Z',
  })
  db.close()
  const seen: URL[] = []
  server.use(
    http.get(`${API}/calibration/pieces`, ({ request }) => {
      seen.push(new URL(request.url))
      return HttpResponse.json({
        data: [
          apiPiece('39724', '5', {
            providerId: '4',
            metadata: { name: 'site', ipfsRootCID: 'bafyroot' },
          }),
          apiPiece('39723', '1', { metadata: { name: 'notes.txt' } }),
          apiPiece('39723', '0', {
            metadata: { name: 'site', ipfsRootCID: 'bafyroot' },
          }),
          apiPiece('39700', '3', { cid: null, rawSize: null }),
        ],
        nextCursor: 'next-page',
      })
    })
  )
  const json = await run(['ls', '--limit', '4'])
  assert.deepEqual(
    Object.fromEntries(seen[0]?.searchParams ?? []),
    { owner: ROOT, limit: '4', removed: 'false' },
    'query'
  )
  const browser = (cid: string) =>
    `${API}/get/${cid}?network=calibration&browser=true`
  assert.deepEqual(json, {
    data: {
      network: 'calibration',
      pieces: [
        {
          dataSetId: '39724',
          pieceId: '5',
          providerId: '4',
          pieceCid: 'bafkzcibpiece39724x5',
          rootCid: 'bafyroot',
          name: 'site',
          rawSize: '2048',
          metadata: { name: 'site', ipfsRootCID: 'bafyroot' },
          removed: false,
          addedAtBlock: '3000002',
          url: browser('bafyroot'),
          resourceRef: 'res_site',
        },
        {
          dataSetId: '39723',
          pieceId: '1',
          providerId: '9',
          pieceCid: 'bafkzcibpiece39723x1',
          name: 'notes.txt',
          rawSize: '2048',
          metadata: { name: 'notes.txt' },
          removed: false,
          addedAtBlock: '3000002',
          url: browser('bafkzcibpiece39723x1'),
        },
        {
          dataSetId: '39723',
          pieceId: '0',
          providerId: '9',
          pieceCid: 'bafkzcibpiece39723x0',
          rootCid: 'bafyroot',
          name: 'site',
          rawSize: '2048',
          metadata: { name: 'site', ipfsRootCID: 'bafyroot' },
          removed: false,
          addedAtBlock: '3000002',
          url: browser('bafyroot'),
          resourceRef: 'res_site',
        },
        {
          dataSetId: '39700',
          pieceId: '3',
          providerId: '9',
          metadata: {},
          removed: false,
          addedAtBlock: '3000002',
        },
      ],
      nextCursor: 'next-page',
    },
  })
})

test('ls passes --provider, --cursor, and --all through', async () => {
  const seen: URL[] = []
  server.use(
    http.get(`${API}/calibration/pieces`, ({ request }) => {
      seen.push(new URL(request.url))
      return HttpResponse.json({ data: [], nextCursor: null })
    })
  )
  const json = await run(['ls', '--provider', '9', '--cursor', 'abc', '--all'])
  assert.deepEqual(Object.fromEntries(seen[0]?.searchParams ?? []), {
    owner: ROOT,
    limit: '20',
    cursor: 'abc',
    provider_id: '9',
  })
  assert.deepEqual(json, { data: { network: 'calibration', pieces: [] } })
})

test('ls reports a filecoin-api outage as retryable', async () => {
  server.use(
    http.get(`${API}/calibration/pieces`, () =>
      HttpResponse.json(
        { error: { code: 'unavailable', message: 'try later' } },
        { status: 503 }
      )
    )
  )
  const json = await run(['ls'])
  const error = json.error as { code: string; retryable: boolean }
  assert.equal(error.code, 'service_unavailable')
  assert.equal(error.retryable, true)
})

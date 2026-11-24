/**
 * Runs `filecoin delete` in process against filecoin-api and chain RPC
 * responses mocked with msw, which intercepts `globalThis.fetch`. Unmocked
 * requests fail the test, so every case also proves which requests the
 * command sends. `--dry-run` covers how a target resolves to copies and how
 * the chain decides which are live; `test/jobs.test.ts` covers signing.
 *
 * @see https://mswjs.io/docs/api/setup-server
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import type { DataSet, PieceWithDataSet } from '@filecoin-project/api-client'
import { calibration } from '@filoz/synapse-core/chains'
import * as Piece from '@filoz/synapse-core/piece'
import { assertContract, invoke } from 'clipact/testing'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import {
  type Abi,
  type AbiFunction,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  zeroAddress,
} from 'viem'
import { cli } from '../src/cli.ts'
import { openDatabase } from '../src/state/db.ts'
import { type Resource, saveResource } from '../src/state/resources.ts'
import { tempDir } from './helpers.ts'

const API = 'http://api.test'
const RPC = 'http://rpc.test/'
const SESSION_KEY = `0x${'11'.repeat(32)}`
const ROOT = '0x1111111111111111111111111111111111111111'
const CALIBRATION = '314159'

/** Environment of every run: the folder, the API, the RPC, and CI credentials. */
const env: Record<string, string> = {
  FILECOIN_API_URL: API,
  FILECOIN_RPC_URL: RPC,
  FILECOIN_SESSION_KEY: SESSION_KEY,
  FILECOIN_ROOT_ADDRESS: ROOT,
}

/** On-chain state of pieces by `dataSetId/pieceId`; unlisted pieces are live. */
const chain = new Map<string, 'scheduled' | 'removed'>()

const server = setupServer()

before(async () => {
  env.FILECOIN_CONFIG_DIR = join(await tempDir(), 'filecoin')
  server.listen({ onUnhandledFrame: 'error' })
})
afterEach(() => {
  server.resetHandlers()
  chain.clear()
})
after(() => server.close())

/** Runs the CLI in process and returns the contract-checked JSON result. */
async function run(args: string[]): Promise<Record<string, unknown>> {
  return assertContract(await invoke(cli, args, { env }))
}

/** The error code of a result. */
function code(json: Record<string, unknown>): string | undefined {
  return (json.error as { code?: string } | undefined)?.code
}

/** The PieceCID of `text`, so `Piece.tryFrom` accepts it. */
function pieceCidOf(text: string): string {
  const hasher = Piece.hasher()
  hasher.write(new TextEncoder().encode(text.repeat(64)))
  return hasher.finalize().toString()
}

/** A CIDv1 of `text` that is not a PieceCID, standing in for a root. */
async function rootCidOf(text: string): Promise<string> {
  const digest = await sha256.digest(new TextEncoder().encode(text))
  return CID.create(1, raw.code, digest).toString()
}

/** Save a file resource in local state with one copy on provider 7. */
function saveFile(
  ref: string,
  pieceCid: string,
  dataSetId: string,
  pieceId: string,
  status: Resource['status'] = 'active'
): Resource {
  const resource: Resource = {
    ref,
    kind: 'file',
    name: 'notes.txt',
    chainId: CALIBRATION,
    payer: ROOT,
    pieceCid,
    size: 2048,
    copies: [
      {
        providerId: '7',
        dataSetId,
        pieceId,
        serviceURL: 'https://sp7.example',
      },
    ],
    status,
    createdAt: '2026-11-13T00:00:00.000Z',
  }
  const db = openDatabase(env.FILECOIN_CONFIG_DIR as string)
  saveResource(db, resource)
  db.close()
  return resource
}

/** A filecoin-api piece of the payer on provider 9. */
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

/**
 * Answer `/pieces` with `data`, and `/providers/9` and `/data-sets/{id}` for
 * the copies it finds. Returns the paths and queries of the requests.
 */
function mockApi(data: PieceWithDataSet[]): string[] {
  const seen: string[] = []
  const record = (request: Request) => {
    const url = new URL(request.url)
    seen.push(`${url.pathname}${url.search}`)
  }
  server.use(
    http.get(`${API}/v1/calibration/pieces`, ({ request }) => {
      record(request)
      return HttpResponse.json({ data, nextCursor: null })
    }),
    http.get(`${API}/v1/calibration/providers/9`, ({ request }) => {
      record(request)
      return HttpResponse.json({
        data: { providerId: '9', serviceUrl: 'https://sp9.example' },
      })
    }),
    http.get(`${API}/v1/calibration/data-sets/:id`, ({ request, params }) => {
      record(request)
      return HttpResponse.json({
        data: {
          dataSetId: params.id,
          owner: ROOT,
          providerId: '9',
          source: 'filecoin-pin',
        } as DataSet,
      })
    })
  )
  return seen
}

/** The output of `getDataSet` for a data set the payer pays for. */
function dataSetInfo(abi: Abi) {
  const fn = abi.find(
    (item): item is AbiFunction =>
      item.type === 'function' && item.name === 'getDataSet'
  )
  const output = fn?.outputs[0] as {
    components: readonly { name?: string; type: string }[]
  }
  const fields = output.components
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.name === 'payer'
        ? ROOT
        : field.type === 'address'
          ? zeroAddress
          : 1n,
    ])
  )
}

/**
 * Answer the chain reads of a delete: FWSS `getDataSet`, and PDPVerifier
 * `pieceLive` and `getScheduledRemovals`, from {@link chain}.
 */
function mockChain(): string[] {
  const reads: string[] = []
  const { fwssView, pdp } = calibration.contracts
  server.use(
    http.post(RPC, async ({ request }) => {
      const body = (await request.json()) as {
        id: number
        method: string
        params: [{ to: Hex; data: Hex }]
      }
      assert.equal(body.method, 'eth_call')
      const [call] = body.params
      const contract =
        call.to.toLowerCase() === fwssView.address.toLowerCase()
          ? fwssView
          : pdp
      const { functionName, args } = decodeFunctionData({
        abi: contract.abi as Abi,
        data: call.data,
      })
      const [dataSetId, pieceId] = args as unknown as [bigint, bigint?]
      reads.push(`${functionName}(${(args ?? []).join(',')})`)
      const state = chain.get(`${dataSetId}/${pieceId}`)
      const result =
        functionName === 'getDataSet'
          ? dataSetInfo(contract.abi as Abi)
          : functionName === 'pieceLive'
            ? state !== 'removed'
            : [...chain]
                .filter(
                  ([key, value]) =>
                    value === 'scheduled' && key.startsWith(`${dataSetId}/`)
                )
                .map(([key]) => BigInt(key.split('/')[1] as string))
      return HttpResponse.json({
        jsonrpc: '2.0',
        id: body.id,
        result: encodeFunctionResult({
          abi: contract.abi as Abi,
          functionName,
          result,
        }),
      })
    })
  )
  return reads
}

test('delete <pieceCid> --dry-run lists every copy and what the chain shows', async () => {
  const pieceCid = pieceCidOf('shared')
  const resource = saveFile('res_shared', pieceCid, '200', '0')
  const seen = mockApi([
    apiPiece('200', '0', { cid: pieceCid }),
    apiPiece('201', '4', { cid: pieceCid }),
    apiPiece('202', '1', { cid: pieceCid }),
    apiPiece('203', '2', { cid: pieceCid, removed: true }),
  ])
  mockChain()
  chain.set('202/1', 'scheduled')

  const json = await run(['delete', pieceCid, '--dry-run'])
  assert.deepEqual(seen.sort(), [
    '/v1/calibration/data-sets/201',
    '/v1/calibration/data-sets/202',
    `/v1/calibration/pieces?owner=${ROOT}&limit=200&cid=${pieceCid}`,
    '/v1/calibration/providers/9',
  ])
  assert.deepEqual(json, {
    data: {
      dryRun: true,
      target: pieceCid,
      removals: [
        {
          dataSetId: '200',
          pieceId: '0',
          providerId: '7',
          source: 'filecoin-cli',
          resourceRef: 'res_shared',
          state: 'live',
        },
        {
          dataSetId: '201',
          pieceId: '4',
          providerId: '9',
          source: 'filecoin-pin',
          state: 'live',
        },
        {
          dataSetId: '202',
          pieceId: '1',
          providerId: '9',
          source: 'filecoin-pin',
          state: 'already_scheduled',
        },
      ],
      resources: [resource],
    },
  })

  const narrowed = await run([
    'delete',
    pieceCid,
    '--provider',
    '7',
    '--dry-run',
  ])
  assert.deepEqual(
    (narrowed.data as { removals: { dataSetId: string }[] }).removals.map(
      (removal) => removal.dataSetId
    ),
    ['200']
  )
})

test('delete <dataSetId>/<pieceId> --dry-run names one copy', async () => {
  const piece = apiPiece('210', '3')
  server.use(
    http.get(`${API}/v1/calibration/data-sets/210/pieces/3`, () =>
      HttpResponse.json({ data: piece })
    )
  )
  mockApi([])
  const reads = mockChain()

  const json = await run(['delete', '210/3', '--dry-run'])
  assert.deepEqual((json.data as { removals: unknown[] }).removals, [
    {
      dataSetId: '210',
      pieceId: '3',
      providerId: '9',
      source: 'filecoin-pin',
      state: 'live',
    },
  ])
  assert.deepEqual(reads.sort(), [
    'getDataSet(210)',
    'getScheduledRemovals(210)',
    'pieceLive(210,3)',
  ])

  const elsewhere = await run([
    'delete',
    '210/3',
    '--provider',
    '7',
    '--dry-run',
  ])
  assert.equal(code(elsewhere), 'not_found')
  assert.deepEqual(elsewhere.next, [
    {
      by: 'agent',
      command: 'filecoin delete 210/3 --dry-run',
      description: 'List the copies and their providers',
    },
  ])
})

test('delete of a piece newer than the index uses the local copy', async () => {
  const pieceCid = pieceCidOf('fresh')
  saveFile('res_fresh', pieceCid, '220', '0')
  const seen = mockApi([])
  mockChain()

  const json = await run(['delete', pieceCid, '--dry-run'])
  assert.deepEqual(seen, [
    `/v1/calibration/pieces?owner=${ROOT}&limit=200&cid=${pieceCid}`,
  ])
  assert.deepEqual(
    (json.data as { removals: { resourceRef?: string }[] }).removals.map(
      (removal) => removal.resourceRef
    ),
    ['res_fresh']
  )
})

test('delete of a target with nothing left to remove fails before signing', async () => {
  const pieceCid = pieceCidOf('gone')
  mockApi([apiPiece('230', '0', { cid: pieceCid, removed: true })])
  const removed = await run(['delete', pieceCid, '--yes'])
  assert.equal(code(removed), 'invalid_input')
  assert.match(
    (removed.error as { message: string }).message,
    /already removed/
  )

  mockApi([apiPiece('231', '0', { cid: pieceCid })])
  mockChain()
  chain.set('231/0', 'scheduled')
  const scheduled = await run(['delete', pieceCid, '--dry-run'])
  assert.equal(code(scheduled), 'invalid_input')
  assert.match(
    (scheduled.error as { message: string }).message,
    /already scheduled for removal/
  )

  mockApi([])
  const missing = await run(['delete', pieceCidOf('missing'), '--yes'])
  assert.equal(code(missing), 'not_found')
  assert.deepEqual(missing.next, [
    {
      by: 'agent',
      command: 'filecoin ls',
      description: "List the wallet's stored pieces",
    },
  ])
})

test('delete <rootCid> of several PieceCIDs asks for one', async () => {
  const root = await rootCidOf('root')
  const [a, b] = [pieceCidOf('root-a'), pieceCidOf('root-b')]
  const metadata = { ipfsRootCID: root }
  mockApi([
    apiPiece('240', '0', { cid: a, metadata }),
    apiPiece('241', '0', { cid: b, metadata }),
  ])
  const json = await run(['delete', root, '--yes'])
  assert.equal(code(json), 'invalid_input')
  assert.deepEqual(
    (json.next as { command: string }[]).map((n) => n.command),
    [`filecoin delete ${a}`, `filecoin delete ${b}`]
  )
})

test('delete <ref> reads local state, not filecoin-api', async () => {
  saveFile('res_pending', pieceCidOf('pending'), '250', '0', 'removal_pending')
  const pending = await run(['delete', 'res_pending', '--yes'])
  assert.equal(code(pending), 'invalid_input')
  const missing = await run(['delete', 'res_missing', '--yes'])
  assert.equal(code(missing), 'not_found')
  const invalid = await run(['delete', 'not-a-cid', '--yes'])
  assert.equal(code(invalid), 'invalid_input')
})

test('delete confirms by target kind before reading anything', async () => {
  const reason = async (target: string, ...args: string[]) => {
    const json = await run(['delete', target, ...args])
    assert.equal(code(json), 'confirmation_required')
    return (json.error as { details: { reason: string } }).details.reason
  }
  assert.match(
    await reason('res_abc'),
    /^Schedules removal of every copy of res_abc;/
  )
  assert.equal(
    await reason('39723/0'),
    'Schedules removal of piece 0 from data set 39723; the provider deletes that copy.'
  )
  const cid = pieceCidOf('confirm')
  const any = await reason(cid, '--provider', '9')
  assert.match(any, /on provider 9 that this wallet pays for, in any data set/)
  assert.match(any, /data sets other tools created/)
  assert.match(any, /--dry-run/)
})

test('delete <pieceCid> reads every page of pieces', async () => {
  const pieceCid = pieceCidOf('paged')
  const seen = mockApi([])
  server.use(
    http.get(`${API}/v1/calibration/pieces`, ({ request }) => {
      const url = new URL(request.url)
      seen.push(`${url.pathname}${url.search}`)
      const first = url.searchParams.get('cursor') !== 'page-2'
      return HttpResponse.json({
        data: [apiPiece(first ? '260' : '261', '0', { cid: pieceCid })],
        nextCursor: first ? 'page-2' : null,
      })
    })
  )
  mockChain()

  const json = await run(['delete', pieceCid, '--dry-run'])
  assert.deepEqual(
    seen.filter((path) => path.includes('/pieces')),
    [
      `/v1/calibration/pieces?owner=${ROOT}&limit=200&cid=${pieceCid}`,
      `/v1/calibration/pieces?owner=${ROOT}&limit=200&cid=${pieceCid}&cursor=page-2`,
    ]
  )
  assert.deepEqual(
    (json.data as { removals: { dataSetId: string }[] }).removals.map(
      (removal) => removal.dataSetId
    ),
    ['260', '261']
  )
})

test('delete --provider looks up only that provider', async () => {
  const pieceCid = pieceCidOf('two-providers')
  // No handler answers /providers/13, so a lookup of it fails the test.
  const seen = mockApi([
    apiPiece('270', '0', { cid: pieceCid }),
    apiPiece('271', '0', { cid: pieceCid, providerId: '13' }),
  ])
  mockChain()

  const json = await run(['delete', pieceCid, '--provider', '9', '--dry-run'])
  assert.deepEqual(
    (json.data as { removals: { dataSetId: string }[] }).removals.map(
      (removal) => removal.dataSetId
    ),
    ['270']
  )
  assert.ok(!seen.some((path) => path.includes('/providers/13')))

  const none = await run(['delete', pieceCid, '--provider', '5', '--dry-run'])
  assert.equal(code(none), 'not_found')
})

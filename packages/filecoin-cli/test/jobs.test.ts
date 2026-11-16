import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Commit } from '@filoz/synapse-core/sp'
import { SIZE_CONSTANTS } from '@filoz/synapse-core/utils'
import { CliError } from 'clipact'
import type { Hex } from 'viem'
import { invalidInput, operationError } from '../src/errors.ts'
import { openDatabase } from '../src/state/db.ts'
import {
  getOperation,
  type LegacyCommit,
  listOperations,
  updateOperation,
} from '../src/state/operations.ts'
import { getResource } from '../src/state/resources.ts'
import {
  CAR_DATA_SET_METADATA,
  estimatePut,
  type JobContext,
  RAW_DATA_SET_METADATA,
  runOperation,
  startPut,
  startRemove,
} from '../src/storage/jobs.ts'
import type { CommittedPiece, StorageBackend } from '../src/storage/types.ts'
import { tempDir } from './helpers.ts'

const TX = `0x${'aa'.repeat(32)}` as Hex
const PAYER: Hex = '0x00000000000000000000000000000000000000aa'

/** Options for {@link fakeBackend}. */
type FakeOptions = {
  existingDataSet?: boolean
  stored?: boolean
  /** The payer cannot afford the upload. */
  unfunded?: boolean
  /** The payer has funds but has not approved Warm Storage. */
  unapproved?: boolean
  /** The first commit wait fails, as if the connection dropped. */
  failWaitOnce?: boolean
  /** The first submission lands on chain but its response is lost. */
  loseResponseOnce?: boolean
  /** The first submission fails before reaching the provider. */
  failSubmitOnce?: boolean
  /** The first commit transaction is reported as failed. */
  rejectOnce?: boolean
  /** The first removal transaction reverts. */
  revertOnce?: boolean
}

/**
 * A storage backend that records calls and simulates FWSS: a submitted
 * commit lands under its nonce unless it is rejected, and `findCommit` reads
 * that record the way `clientNonces` does.
 */
function fakeBackend(options: FakeOptions = {}) {
  const calls = {
    select: [] as unknown[],
    upload: 0,
    sign: 0,
    submitted: [] as Hex[],
    commits: [] as Commit[],
    find: 0,
    wait: 0,
    remove: 0,
  }
  const landed = new Map<string, CommittedPiece>()
  const once = { ...options }
  const backend: StorageBackend = {
    selectPlacement(opts) {
      calls.select.push(opts.metadata)
      return Promise.resolve({
        providerId: 7n,
        serviceURL: 'https://sp.example',
        payee: '0x0000000000000000000000000000000000000007',
        ...(options.existingDataSet
          ? { dataSetId: 42n, clientDataSetId: 9n }
          : {}),
      })
    },
    quote: () =>
      Promise.resolve({
        ready: !(options.unfunded || options.unapproved),
        depositNeeded: options.unfunded ? 10n ** 18n : 0n,
        needsApproval: options.unapproved ?? false,
        ratePerMonth: 123n,
        lockup: 456n,
        fundingUrl:
          'https://pay.example/console/setup?network=calibration&approval=unlimited',
      }),
    hasPiece: () => Promise.resolve(options.stored ?? false),
    upload() {
      calls.upload++
      return Promise.resolve()
    },
    signCommit({ placement, pieceCid, metadata, pieceMetadata }) {
      calls.sign++
      const signed = {
        nonce: String(calls.sign),
        payer: PAYER,
        pieces: [{ pieceCid, metadata: pieceMetadata }],
        extraData: `0x0${calls.sign}` as Hex,
      }
      const commit: Commit =
        placement.dataSetId == null
          ? {
              ...signed,
              kind: 'createDataSetAndAddPieces',
              clientDataSetId: '77',
              payee: placement.payee,
              metadata,
              cdn: false,
            }
          : {
              ...signed,
              kind: 'addPieces',
              dataSetId: placement.dataSetId.toString(),
              clientDataSetId: String(placement.clientDataSetId),
            }
      return Promise.resolve(commit)
    },
    submitCommit({ commit }) {
      calls.submitted.push(commit.extraData)
      calls.commits.push(commit)
      if (once.failSubmitOnce) {
        once.failSubmitOnce = false
        return Promise.reject(new Error('connect ECONNREFUSED'))
      }
      landed.set(commit.nonce, {
        dataSetId: commit.kind === 'addPieces' ? 42n : 100n,
        pieceId: 5n,
      })
      if (once.loseResponseOnce) {
        once.loseResponseOnce = false
        return Promise.reject(new Error('socket hang up'))
      }
      return Promise.resolve({ transactionHash: TX })
    },
    findCommit({ commit }) {
      calls.find++
      return Promise.resolve(landed.get(commit.nonce))
    },
    waitForCommit({ commit }) {
      calls.wait++
      const { nonce } = commit
      if (once.failWaitOnce) {
        once.failWaitOnce = false
        return Promise.reject(new Error('connection reset'))
      }
      if (once.rejectOnce) {
        once.rejectOnce = false
        landed.delete(nonce)
        return Promise.reject(
          new CliError({ code: 'commit_rejected', message: 'failed' })
        )
      }
      const piece = landed.get(nonce)
      if (!piece)
        return Promise.reject(new Error(`nothing landed for ${nonce}`))
      return Promise.resolve(piece)
    },
    schedulePieceRemoval() {
      calls.remove++
      return Promise.resolve({ transactionHash: TX })
    },
    waitForRemoval() {
      if (once.revertOnce) {
        once.revertOnce = false
        return Promise.resolve({ scheduled: false })
      }
      return Promise.resolve({ scheduled: true })
    },
  }
  return { backend, calls }
}

/** Build a job context over a fresh database. */
async function context(
  backend: StorageBackend
): Promise<JobContext & { root: string; started: string[] }> {
  const root = await tempDir()
  const started: string[] = []
  return {
    root,
    started,
    db: openDatabase(join(root, 'state')),
    backend,
    chainId: '314159',
    payer: PAYER,
    apiUrl: 'https://api.example',
    stagingDir: (id) => join(root, 'state', 'staging', id),
    onOperation: (op) => started.push(op.id),
  }
}

/** Write a random file of `size` bytes under the context root. */
async function file(ctx: { root: string }, name: string, size: number) {
  const path = join(ctx.root, name)
  await writeFile(path, randomBytes(size))
  return path
}

/** The only operation of a context's account. */
function onlyOperation(ctx: JobContext) {
  const { items } = listOperations(ctx.db, {
    chainId: ctx.chainId,
    payer: ctx.payer,
    limit: 2,
  })
  assert.equal(items.length, 1)
  return items[0] as NonNullable<(typeof items)[0]>
}

test('put --raw stores a file in a new data set and records the resource', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path, raw: true })
  assert.equal(result.state, 'ready')
  assert.equal(result.resource.kind, 'file')
  assert.equal(result.resource.name, 'report.pdf')
  assert.equal(result.resource.rootCid, undefined)
  assert.equal(result.resource.size, 4096)
  assert.deepEqual(result.resource.copies, [
    {
      providerId: '7',
      dataSetId: '100',
      pieceId: '5',
      serviceURL: 'https://sp.example',
    },
  ])
  assert.deepEqual(result.urls, {
    piece: `https://api.example/get/${result.resource.pieceCid}?network=calibration`,
    browser: `https://api.example/get/${result.resource.pieceCid}?network=calibration&browser=true`,
  })
  assert.equal(result.resource.url, result.urls.browser)
  assert.deepEqual(calls.select, [RAW_DATA_SET_METADATA])
  // On-chain namespace: changing it orphans existing data sets.
  assert.deepEqual(RAW_DATA_SET_METADATA, { source: 'filecoin-cli' })
  assert.deepEqual(CAR_DATA_SET_METADATA, {
    source: 'filecoin-cli',
    withIPFSIndexing: '',
  })
  assert.equal(calls.submitted.length, 1)
  assert.deepEqual(ctx.started, [result.operationId])
  const op = getOperation(ctx.db, result.operationId)
  assert.equal(op?.executionStatus, 'completed')
  assert.equal(op?.phase, 'done')
  assert.equal(op?.pid, undefined)
})

/** Progress events of a put, recorded in order. */
function recordProgress(ctx: JobContext) {
  const events: {
    phase: string
    message: string
    data?: Record<string, unknown>
  }[] = []
  ctx.progress = (event) => events.push(event)
  return events
}

test('put --raw reports a file link with the provider hint once it is parked', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path, raw: true })
  const phases = events.map((event) => event.phase)
  assert.ok(phases.indexOf('link') > phases.indexOf('uploading'))
  assert.ok(phases.indexOf('link') < phases.indexOf('committing'))
  const link = events.find((event) => event.phase === 'link')
  assert.deepEqual(link?.data, {
    pieceCid: result.resource.pieceCid,
    urls: {
      piece: `${result.urls.piece}&provider=7`,
      browser: `${result.urls.browser}&provider=7`,
    },
  })
  assert.equal(link?.message, `${result.urls.browser}&provider=7`)
})

test('put stores a file as a CAR with its IPFS root CID by default', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const path = await file(ctx, 'report.pdf', 4096)

  const result = await startPut(ctx, { path })
  assert.equal(result.resource.kind, 'file')
  const { rootCid } = result.resource
  assert.ok(rootCid?.startsWith('bafkrei'))
  assert.ok(result.resource.size > 4096)
  assert.deepEqual(result.urls, {
    piece: `https://api.example/get/${result.resource.pieceCid}?network=calibration`,
    browser: `https://api.example/get/${rootCid}?network=calibration&browser=true`,
  })
  assert.deepEqual(calls.select, [CAR_DATA_SET_METADATA])
  assert.deepEqual(calls.commits[0]?.pieces[0]?.metadata, {
    name: 'report.pdf',
    ipfsRootCID: rootCid,
  })
  const op = getOperation(ctx.db, result.operationId)
  assert.equal(op?.input.format, 'car')
  // The browser link needs the IPFS index, so it follows the commit.
  const phases = events.map((event) => event.phase)
  assert.ok(phases.indexOf('link') > phases.indexOf('committing'))
  await assert.rejects(stat(ctx.stagingDir(result.operationId)), {
    code: 'ENOENT',
  })
})

test('put --raw rejects a directory', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await assert.rejects(startPut(ctx, { path: dir, raw: true }), {
    code: 'invalid_input',
  })
  assert.equal(
    listOperations(ctx.db, { chainId: ctx.chainId, payer: ctx.payer, limit: 1 })
      .items.length,
    0
  )
})

test('a file put saved without a format by filecoin 0.7.0 resumes raw', async () => {
  const { backend, calls } = fakeBackend({ failSubmitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path, raw: true }))
  const failed = onlyOperation(ctx)
  const { format: _, ...legacyInput } = failed.input
  ctx.db
    .prepare('update operations set input = ? where id = ?')
    .run(JSON.stringify(legacyInput), failed.id)

  // As a CAR, the resume would fail: no CAR was staged for this put.
  const result = await runOperation(ctx, failed.id)
  assert.equal(result.resource.rootCid, undefined)
  assert.equal(result.resource.size, 2048)
  assert.equal(calls.upload, 1)
})

test('put reports a folder link once the commit is sent', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const events = recordProgress(ctx)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')

  const result = await startPut(ctx, { path: dir })
  const messages = events.map((event) => event.message)
  const link = events.findIndex((event) => event.phase === 'link')
  const waiting = messages.findIndex((m) =>
    m.startsWith('Waiting for confirmation of transaction 0x')
  )
  assert.ok(link > messages.indexOf('Creating data set and adding piece'))
  assert.ok(link < waiting)
  assert.equal(
    messages[waiting],
    `Waiting for confirmation of transaction ${events[waiting]?.data?.transactionHash}`
  )
  assert.deepEqual(events[link]?.data, {
    pieceCid: result.resource.pieceCid,
    urls: {
      piece: `${result.urls.piece}&provider=7`,
      browser: result.urls.browser,
    },
  })
})

test('put packs a directory, adds to an existing data set, and cleans staging', async () => {
  const { backend, calls } = fakeBackend({ existingDataSet: true })
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')

  const result = await startPut(ctx, { path: dir })
  assert.equal(result.resource.kind, 'folder')
  assert.ok(result.resource.rootCid)
  assert.deepEqual(result.urls, {
    piece: `https://api.example/get/${result.resource.pieceCid}?network=calibration`,
    browser: `https://api.example/get/${result.resource.rootCid}?network=calibration&browser=true`,
  })
  assert.equal(result.resource.url, result.urls.browser)
  assert.deepEqual(calls.select, [CAR_DATA_SET_METADATA])
  assert.equal(result.resource.copies[0]?.dataSetId, '42')
  await assert.rejects(stat(ctx.stagingDir(result.operationId)), {
    code: 'ENOENT',
  })
})

test('put errors carry the operation ID and a resume step, never retryable', async () => {
  const { backend } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)

  const error = await startPut(ctx, { path }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'operation_failed')
  assert.equal(error.retryable, false)
  const op = onlyOperation(ctx)
  assert.equal(
    (error.details as { operationId?: string } | undefined)?.operationId,
    op.id
  )
  assert.deepEqual(error.next?.at(-1), {
    by: 'agent',
    command: `filecoin operations resume ${op.id}`,
    description: 'Continue this operation with its saved input',
  })
  assert.equal(op.executionStatus, 'failed')
})

test('operation errors add the ID to details only for filecoin CLI codes', () => {
  const resume = 'filecoin operations resume op_1'
  const invalid = operationError(invalidInput('Too small.', 'path'), 'op_1')
  assert.deepEqual(invalid.details, [{ path: 'path', message: 'Too small.' }])
  assert.equal(invalid.next?.at(-1)?.command, resume)

  const down = operationError(
    new CliError({ code: 'service_unavailable', message: 'Down.' }),
    'op_1'
  )
  assert.equal(down.details, undefined)
  assert.equal(down.retryable, false)
  assert.equal(down.next?.at(-1)?.command, resume)

  const details = { fundingUrl: 'u', depositNeeded: '1', needsApproval: false }
  const funds = operationError(
    new CliError({ code: 'insufficient_funds', message: 'Fund.', details }),
    'op_1'
  )
  assert.deepEqual(funds.details, { ...details, operationId: 'op_1' })
})

test('resume after a dropped wait finds the landed commit without sending', async () => {
  const { backend, calls } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)

  const result = await runOperation(ctx, failed.id)
  assert.equal(result.state, 'ready')
  assert.equal(calls.upload, 1)
  assert.equal(calls.sign, 1)
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.select.length, 1)
})

test('resume after a lost commit response does not commit twice (#1)', async () => {
  const { backend, calls } = fakeBackend({ loseResponseOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }), { code: 'operation_failed' })
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.transactionHash, undefined)
  assert.ok(failed.checkpoint.commit)

  const result = await runOperation(ctx, failed.id)
  assert.equal(result.resource.copies[0]?.dataSetId, '100')
  assert.equal(calls.sign, 1)
  assert.equal(calls.submitted.length, 1)
})

test('resume resends the same signature when the commit never landed (#1)', async () => {
  const { backend, calls } = fakeBackend({ failSubmitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)

  await runOperation(ctx, failed.id)
  assert.equal(calls.sign, 1)
  assert.equal(calls.submitted.length, 2)
  assert.equal(calls.submitted[0], calls.submitted[1])
})

test('a rejected commit is resent with the same signature on resume', async () => {
  const { backend, calls } = fakeBackend({ rejectOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }), { code: 'commit_rejected' })
  const failed = onlyOperation(ctx)
  assert.equal(failed.checkpoint.transactionHash, undefined)

  const result = await runOperation(ctx, failed.id)
  assert.equal(result.state, 'ready')
  assert.equal(calls.sign, 1)
  assert.deepEqual(calls.submitted, ['0x01', '0x01'])
})

/**
 * Rewrite an operation's saved commit in the shape `filecoin` 0.7.0 saved,
 * with the provider status URL it saved after sending.
 */
function saveLegacyCommit(
  ctx: JobContext,
  id: string,
  options: { statusUrl?: string } = {}
): LegacyCommit {
  const op = getOperation(ctx.db, id)
  const commit = op?.checkpoint.commit
  assert.ok(commit && 'kind' in commit)
  const legacy: LegacyCommit = {
    created: commit.kind === 'createDataSetAndAddPieces',
    nonce: commit.nonce,
    ...(commit.kind === 'createDataSetAndAddPieces'
      ? { clientDataSetId: commit.clientDataSetId }
      : {}),
    extraData: commit.extraData,
  }
  updateOperation(ctx.db, id, {
    checkpoint: { commit: legacy, ...options },
  })
  return legacy
}

test('resume sends a commit saved by filecoin 0.7.0 as a synapse-core commit', async () => {
  const { backend, calls } = fakeBackend({ failSubmitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path, raw: true }))
  const failed = onlyOperation(ctx)
  const legacy = saveLegacyCommit(ctx, failed.id)

  const result = await runOperation(ctx, failed.id)
  assert.equal(result.state, 'ready')
  assert.equal(calls.sign, 1)
  assert.deepEqual(calls.commits[1], {
    kind: 'createDataSetAndAddPieces',
    clientDataSetId: legacy.clientDataSetId,
    nonce: legacy.nonce,
    payee: '0x0000000000000000000000000000000000000007',
    payer: PAYER,
    metadata: RAW_DATA_SET_METADATA,
    cdn: false,
    pieces: [
      { pieceCid: result.resource.pieceCid, metadata: { name: 'data.bin' } },
    ],
    extraData: legacy.extraData,
  })
  assert.deepEqual(calls.commits[1], calls.commits[0])
})

test('resume finds a landed commit saved by filecoin 0.7.0 with its status URL', async () => {
  const { backend, calls } = fakeBackend({
    existingDataSet: true,
    failWaitOnce: true,
  })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 2048)
  await assert.rejects(startPut(ctx, { path }))
  const failed = onlyOperation(ctx)
  saveLegacyCommit(ctx, failed.id, { statusUrl: 'https://sp.example/status/1' })

  const result = await runOperation(ctx, failed.id)
  assert.equal(result.resource.copies[0]?.dataSetId, '42')
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.find, 1)
})

test('resume of a completed operation returns its saved outcome (#4)', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })

  const again = await runOperation(ctx, put.operationId)
  assert.deepEqual(again, put)
  assert.equal(calls.submitted.length, 1)
  assert.equal(calls.upload, 1)
})

test('put stops with insufficient_funds, a funding step, and the operation', async () => {
  const { backend, calls } = fakeBackend({ unfunded: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const error = await startPut(ctx, { path }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'insufficient_funds')
  assert.deepEqual(
    error.next?.map((step) => step.by),
    ['user', 'agent']
  )
  assert.equal(
    (error.details as { operationId?: string } | undefined)?.operationId,
    onlyOperation(ctx).id
  )
  assert.equal(calls.upload, 0)
})

test('put asks only for the approval when no deposit is needed', async () => {
  const { backend } = fakeBackend({ unapproved: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const error = await startPut(ctx, { path }).catch((e: unknown) => e)
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'insufficient_funds')
  assert.equal(
    error.message,
    'The payer must approve Warm Storage before uploading.'
  )
  assert.match(
    String(error.next?.[0]?.description),
    /^Approve Warm Storage at /
  )
})

test('put skips the upload when the provider already has the piece', async () => {
  const { backend, calls } = fakeBackend({ stored: true })
  const ctx = await context(backend)
  const phases: string[] = []
  ctx.progress = (event) => phases.push(event.phase)
  const path = await file(ctx, 'data.bin', 1024)
  await startPut(ctx, { path })
  assert.equal(calls.upload, 0)
  assert.equal(calls.submitted.length, 1)
  assert.ok(phases.includes('link'))
})

test('resume refuses a source that changed since the job started', async () => {
  const { backend } = fakeBackend({ failWaitOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  await assert.rejects(startPut(ctx, { path, raw: true }))
  const failed = onlyOperation(ctx)
  await writeFile(path, randomBytes(1024))
  await assert.rejects(runOperation(ctx, failed.id), {
    code: 'source_changed',
  })
})

test('put rejects content below the minimum piece size', async () => {
  const { backend } = fakeBackend()
  const ctx = await context(backend)
  const path = join(ctx.root, 'tiny.txt')
  await writeFile(path, 'hi')
  await assert.rejects(startPut(ctx, { path }), { code: 'invalid_input' })
})

test('put rejects content over the piece limit before packing', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  // A sparse file: its size is past the limit, but it takes no disk space.
  const path = join(ctx.root, 'huge.bin')
  await writeFile(path, '')
  await truncate(path, SIZE_CONSTANTS.MAX_UPLOAD_SIZE + 1)
  const dir = join(ctx.root, 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'huge.bin'), '')
  await truncate(join(dir, 'huge.bin'), SIZE_CONSTANTS.MAX_UPLOAD_SIZE + 1)

  for (const target of [path, dir]) {
    await assert.rejects(startPut(ctx, { path: target }), {
      code: 'invalid_input',
    })
    await assert.rejects(estimatePut({ path: target }), {
      code: 'invalid_input',
    })
  }
  const { items } = listOperations(ctx.db, {
    chainId: ctx.chainId,
    payer: ctx.payer,
    limit: 1,
  })
  assert.equal(items.length, 0)
  await assert.rejects(stat(join(ctx.root, 'state', 'staging')), {
    code: 'ENOENT',
  })
  assert.equal(calls.select.length, 0)
})

test('an interrupted put fails with the abort reason, not operation_failed', async () => {
  const { backend } = fakeBackend()
  const controller = new AbortController()
  const ctx = await context({
    ...backend,
    upload() {
      controller.abort('SIGTERM')
      return Promise.reject(new Error('aborted'))
    },
  })
  ctx.signal = controller.signal
  const path = await file(ctx, 'data.bin', 1024)
  await assert.rejects(startPut(ctx, { path }), { message: 'aborted' })
  const op = onlyOperation(ctx)
  assert.equal(op.executionStatus, 'failed')
  assert.equal(op.error, 'Interrupted')
})

test('delete schedules removal and marks the resource pending', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })
  const events = recordProgress(ctx)

  const removed = await startRemove(ctx, put.resource.ref)
  assert.equal(removed.state, 'removal_pending')
  assert.equal(calls.remove, 1)
  assert.deepEqual(events.at(-1), {
    phase: 'removing',
    message: `Waiting for confirmation of removal transaction ${TX}`,
    data: { transactionHash: TX },
  })
  assert.equal(getResource(ctx.db, put.resource.ref)?.status, 'removal_pending')
  assert.equal(
    getOperation(ctx.db, removed.operationId)?.executionStatus,
    'completed'
  )
  await assert.rejects(startRemove(ctx, 'res_missing'), { code: 'not_found' })
  await assert.rejects(startRemove(ctx, put.resource.ref), {
    code: 'invalid_input',
  })
})

test('a reverted removal keeps the resource and is resumable (#2)', async () => {
  const { backend, calls } = fakeBackend({ revertOnce: true })
  const ctx = await context(backend)
  const path = await file(ctx, 'data.bin', 1024)
  const put = await startPut(ctx, { path })

  const error = await startRemove(ctx, put.resource.ref).catch(
    (e: unknown) => e
  )
  assert.ok(error instanceof CliError)
  assert.equal(error.code, 'removal_reverted')
  assert.equal(getResource(ctx.db, put.resource.ref)?.status, 'active')
  const operationId = (error.details as { operationId?: string } | undefined)
    ?.operationId as string
  const failed = getOperation(ctx.db, operationId)
  assert.equal(failed?.executionStatus, 'failed')
  assert.equal(failed?.checkpoint.transactionHash, undefined)

  const resumed = await runOperation(ctx, operationId)
  assert.equal(resumed.state, 'removal_pending')
  assert.equal(calls.remove, 2)
})

test('estimatePut sizes a directory and prices it without side effects', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const dir = join(ctx.root, 'site')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)'.repeat(20))

  const estimate = await estimatePut({ path: dir, backend })
  assert.equal(estimate.kind, 'folder')
  assert.equal(estimate.files, 2)
  assert.ok(estimate.rootCid)
  assert.ok(estimate.size > 0)
  assert.equal(estimate.quote?.ratePerMonth, 123n)
  assert.equal(estimate.placement?.providerId, 7n)
  assert.equal(calls.upload + calls.sign + calls.submitted.length, 0)

  const offline = await estimatePut({ path: dir })
  assert.equal(offline.quote, undefined)
  assert.equal(offline.rootCid, estimate.rootCid)
})

test('estimatePut packs a file by default and sizes it raw with --raw', async () => {
  const { backend, calls } = fakeBackend()
  const ctx = await context(backend)
  const path = await file(ctx, 'report.pdf', 4096)

  const car = await estimatePut({ path, backend })
  assert.equal(car.kind, 'file')
  assert.ok(car.rootCid)
  assert.ok(car.size > 4096)
  const raw = await estimatePut({ path, backend, raw: true })
  assert.equal(raw.rootCid, undefined)
  assert.equal(raw.size, 4096)
  assert.deepEqual(calls.select, [CAR_DATA_SET_METADATA, RAW_DATA_SET_METADATA])
})

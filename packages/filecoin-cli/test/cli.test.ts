/**
 * Runs `filecoin` in process through clipact's strict test harness: every result
 * must match its command's output schema, error codes must be declared, and
 * stdout must be one JSON object with `data` (exit 0) or `error` (exit 1). These
 * cases stay offline: no session, a pending login, or validation errors.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { before, test } from 'node:test'
import {
  assertContract,
  assertDefinitions,
  invoke,
  schemas,
} from 'clipact/testing'
import { cli } from '../src/cli.ts'
import { openConfig } from '../src/config.ts'
import { tempDir } from './helpers.ts'

const SESSION_KEY = `0x${'11'.repeat(32)}`
const ROOT = '0x1111111111111111111111111111111111111111'

/** Runs the CLI in process and returns the asserted result and its `data`. */
async function run(
  args: string[],
  env: Record<string, string> = {}
): Promise<{
  json: Record<string, unknown>
  data: Record<string, unknown>
  stderr: string
}> {
  const result = await invoke(cli, args, { env })
  const json = assertContract(result)
  return {
    json,
    data: (json.data ?? {}) as Record<string, unknown>,
    stderr: result.stderr,
  }
}

/** Error code of a result. */
function code(json: Record<string, unknown>): string | undefined {
  return (json.error as { code: string } | undefined)?.code
}

before(async () => {
  // State and config locations come from the real environment, like the
  // RPC and console overrides; command input comes from `invoke`'s env.
  const dir = await tempDir()
  process.env.FILECOIN_CONFIG_DIR = join(dir, 'config')
  process.env.FILECOIN_STATE_DIR = join(dir, 'state')
})

test('definitions are valid', () => assertDefinitions(cli))

test('schemas cover every command, and aliases resolve to them', async () => {
  assert.deepEqual(Object.keys(schemas(cli)).sort(), [
    'delete',
    'doctor',
    'get',
    'inspect',
    'login',
    'logout',
    'ls',
    'operations inspect',
    'operations ls',
    'operations resume',
    'put',
    'skills install',
    'skills status',
    'skills uninstall',
    'status',
  ])
  const { data } = await run(['schema', 'publish'])
  assert.equal(data.command, 'put')
  assert.deepEqual(data.aliases, ['publish'])
  assert.deepEqual(data.secrets, ['sessionKey'])
})

test('reads without a session ask the user to log in', async () => {
  const { json } = await run(['ls'])
  assert.equal(code(json), 'auth_required')
  assert.deepEqual(json.next, [
    {
      by: 'user',
      command: 'filecoin login',
      description:
        'Authorize a session key in the Filecoin Pay console, then retry',
    },
  ])
})

test('put and its publish alias need a session', async () => {
  assert.equal(code((await run(['put', './missing'])).json), 'auth_required')
  assert.equal(
    code((await run(['publish', './missing'])).json),
    'auth_required'
  )
})

test('put --dry-run describes a directory without a session', async () => {
  const dir = join(await tempDir(), 'site')
  await mkdir(dir)
  await writeFile(join(dir, 'index.html'), '<h1>hello world</h1>')
  const { json, data } = await run(['put', dir, '--dry-run'])
  assert.ok('data' in json)
  assert.equal(data.dryRun, true)
  const estimate = data.estimate as Record<string, unknown>
  assert.equal(estimate.kind, 'folder')
  assert.equal(estimate.files, 1)
  assert.equal(estimate.authorization, 'login_required')
  assert.equal(estimate.cost, undefined)
})

test('delete needs --yes when no human can confirm', async () => {
  const { json } = await run(['rm', 'res_x'])
  assert.equal(code(json), 'confirmation_required')
  assert.deepEqual(json.next, [
    {
      by: 'user',
      command: 'filecoin rm res_x --yes',
      description: 'Approve this action, then run it with --yes',
    },
  ])
  assert.equal(
    code((await run(['delete', 'res_x', '--yes'])).json),
    'auth_required'
  )
})

test('environment credentials scope local reads without a network call', async () => {
  const env = { FILECOIN_SESSION_KEY: SESSION_KEY, FILECOIN_ROOT_ADDRESS: ROOT }
  const { json, stderr } = await run(['ls', '--debug'], env)
  assert.deepEqual(json, { data: { network: 'calibration', resources: [] } })
  assert.ok(!stderr.includes(SESSION_KEY.slice(2)), 'secret leaked to stderr')
  const ops = await run(['operations', 'resume', 'op_missing'], env)
  assert.equal(code(ops.json), 'not_found')
})

test('a session key without its owner is invalid input', async () => {
  const { json } = await run(['ls'], { FILECOIN_SESSION_KEY: SESSION_KEY })
  assert.equal(code(json), 'invalid_input')
})

test('secrets are rejected as flags', async () => {
  const { json } = await run(['ls', '--session-key', SESSION_KEY])
  assert.equal(code(json), 'invalid_input')
  assert.ok(!JSON.stringify(json).includes(SESSION_KEY.slice(2)))
})

test('login rejects unknown scopes and environment credentials', async () => {
  assert.equal(
    code((await run(['login', '--scopes', 'nope'])).json),
    'invalid_input'
  )
  assert.equal(
    code((await run(['login'], { FILECOIN_SESSION_KEY: SESSION_KEY })).json),
    'invalid_input'
  )
})

test('a pending login is reported with the approval link', async () => {
  const network = 'mainnet'
  openConfig().set(`sessions.${network}`, {
    privateKey: SESSION_KEY,
    address: '0x2222222222222222222222222222222222222222',
    scopes: ['addPieces'],
    name: 'filecoin on laptop',
    fromBlock: '1',
    createdAt: new Date(0).toISOString(),
  })
  const status = await run(['status', '--network', network])
  const session = status.data.session as Record<string, unknown>
  assert.equal(session.state, 'pending')
  const url = new URL(String(session.url))
  assert.equal(url.pathname, '/console/setup')
  assert.equal(
    url.searchParams.get('authorize'),
    '0x2222222222222222222222222222222222222222'
  )
  assert.equal(url.searchParams.get('name'), 'filecoin on laptop')

  const ls = await run(['ls', '--network', network])
  assert.equal(code(ls.json), 'login_pending')
  assert.deepEqual(
    (ls.json.next as { by: string }[]).map((step) => step.by),
    ['user', 'agent']
  )

  const logout = await run(['logout', '--network', network])
  assert.equal(logout.data.removed, true)
  assert.equal(logout.data.revokeUrl, undefined)
})

test('logout of an approved key returns the console revoke link', async () => {
  const network = 'mainnet'
  openConfig().set(`sessions.${network}`, {
    privateKey: SESSION_KEY,
    address: '0x2222222222222222222222222222222222222222',
    rootAddress: '0x1111111111111111111111111111111111111111',
    scopes: ['addPieces'],
    fromBlock: '1',
    createdAt: new Date(0).toISOString(),
  })
  const { data } = await run(['logout', '--network', network])
  assert.equal(data.removed, true)
  const url = new URL(String(data.revokeUrl))
  assert.equal(url.pathname, '/console/session-keys')
  assert.equal(
    url.searchParams.get('revoke'),
    '0x2222222222222222222222222222222222222222'
  )
  assert.equal(url.searchParams.get('network'), network)
  assert.equal(url.searchParams.get('utm_source'), 'filecoin-cli')
  assert.equal(url.searchParams.get('utm_term'), 'revoke')
  assert.equal(url.searchParams.get('utm_content'), 'automation')
})

test('console links name the agent and drop their tags on opt-out', async () => {
  const network = 'mainnet'
  openConfig().set(`sessions.${network}`, {
    privateKey: SESSION_KEY,
    address: '0x2222222222222222222222222222222222222222',
    scopes: ['addPieces'],
    fromBlock: '1',
    createdAt: new Date(0).toISOString(),
  })
  /** The pending session's approval link from `filecoin status`. */
  const approvalLink = async (env: Record<string, string> = {}) => {
    const { data } = await run(['status', '--network', network], env)
    return new URL(String((data.session as { url: string }).url))
  }
  const tagged = await approvalLink({ AI_AGENT: 'claude-code' })
  assert.equal(tagged.searchParams.get('utm_term'), 'login')
  assert.equal(tagged.searchParams.get('utm_content'), 'claude-code')

  // Process settings come from the real environment, like the console URL.
  process.env.DO_NOT_TRACK = '1'
  try {
    const untagged = await approvalLink()
    assert.deepEqual(
      [...untagged.searchParams.keys()].filter((key) => key.startsWith('utm_')),
      []
    )
  } finally {
    delete process.env.DO_NOT_TRACK
    openConfig().delete(`sessions.${network}`)
  }
})

test('logout without a session is a no-op', async () => {
  const { json } = await run(['logout'], { FILECOIN_NETWORK: 'mainnet' })
  assert.deepEqual(json, { data: { network: 'mainnet', removed: false } })
})

test('status without a session reports none', async () => {
  const { json } = await run(['status'])
  assert.deepEqual(json, {
    data: { network: 'calibration', session: { state: 'none' } },
  })
})

import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { invoke } from 'clipact/testing'
import { cli } from '../src/cli.ts'
import { resolveNetwork } from '../src/config.ts'
import { openConfig, tempDir } from './helpers.ts'

test('resolveNetwork prefers input, then config, then calibration', async () => {
  const config = openConfig(await tempDir())
  assert.equal(resolveNetwork(undefined, config), 'calibration')
  config.set('network', 'mainnet')
  assert.equal(resolveNetwork(undefined, config), 'mainnet')
  assert.equal(resolveNetwork('calibration', config), 'calibration')
})

test('the folder is private to the user, and created on first use', async () => {
  const dir = join(await tempDir(), 'filecoin')
  await invoke(cli, ['ls'], { env: { FILECOIN_CONFIG_DIR: dir } })
  const { mode } = await stat(dir)
  assert.equal(mode & 0o777, 0o700)
})

test('a relative FILECOIN_CONFIG_DIR is invalid input', async () => {
  const { json } = await invoke(cli, ['ls'], {
    env: { FILECOIN_CONFIG_DIR: 'relative/dir' },
  })
  assert.equal(
    (json as { error?: { code: string } }).error?.code,
    'invalid_input'
  )
})

test('a corrupt config file is config_invalid', async () => {
  const dir = await tempDir()
  const config = openConfig(dir)
  await writeFile(config.path, '{ not json')
  const { json } = await invoke(cli, ['ls'], {
    env: { FILECOIN_CONFIG_DIR: dir },
  })
  assert.equal(
    (json as { error?: { code: string } }).error?.code,
    'config_invalid'
  )
})

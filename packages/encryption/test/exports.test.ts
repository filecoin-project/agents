import assert from 'node:assert/strict'
import { test } from 'node:test'
import pkg from '../package.json' with { type: 'json' }
import * as archive from '../src/archive.ts'
import * as car from '../src/car/index.ts'
import * as envelope from '../src/envelope.ts'
import * as errors from '../src/errors.ts'
import * as grant from '../src/grant.ts'
import * as groupKey from '../src/group-key.ts'
import * as main from '../src/index.ts'
import * as share from '../src/share.ts'

/** Each entry point, by subpath: static imports, so a browser bundle holds them. */
const ENTRY_POINTS: Record<string, object> = {
  '.': main,
  './archive': archive,
  './car': car,
  './envelope': envelope,
  './errors': errors,
  './grant': grant,
  './group-key': groupKey,
  './share': share,
}

/**
 * Functions that return a group key or a Grant's key, which no entry point may
 * export. The key resolvers return a piece key by design: see their JSDoc.
 */
const KEY_HOLDERS = [
  'openGrantWithKey',
  'openSessionGrants',
  'newPieceKey',
  'grantForWrite',
  'grantForPiece',
]

test('no entry point exports a function that returns a group key or a Grant key', () => {
  assert.deepEqual(
    Object.keys(ENTRY_POINTS).sort(),
    Object.keys(pkg.exports).sort()
  )
  for (const [subpath, module] of Object.entries(ENTRY_POINTS)) {
    assert.deepEqual(
      KEY_HOLDERS.filter((name) => name in module),
      [],
      subpath
    )
  }
})

test('every subpath is published from dist', () => {
  assert.deepEqual(
    Object.keys(pkg.publishConfig.exports),
    Object.keys(pkg.exports)
  )
})

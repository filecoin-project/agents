import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as Piece from '@filoz/synapse-core/piece'
import { CliError, defineHandler } from 'clipact'
import { CID } from 'multiformats/cid'
import type { App } from '../app.ts'
import { resolveCredentials } from '../auth/session.ts'
import { get } from '../commands/get.ts'
import { ErrorCodes, notFound } from '../errors.ts'
import { findResourcesByCid, type Resource } from '../state/resources.ts'
import { downloadDag } from '../storage/dag.ts'
import { downloadPiece, outputExists } from '../storage/get.ts'
import { getUrl, providerIpfsUrl, providerPieceUrl } from '../storage/urls.ts'
import { accountScope, appFor, findResource } from './context.ts'

/** Seconds to wait before retrying a root Curio has not indexed yet. */
const INDEX_RETRY_SECONDS = 60

/** Refuse to overwrite an existing file unless forced. */
async function assertWritable(path: string, force: boolean): Promise<void> {
  if (force) return
  if (await stat(path).catch(() => undefined)) throw outputExists(path)
}

/**
 * The managed resource a target names: a ref, or a PieceCID or root CID in
 * local state. A CID is looked up only with credentials, since local state
 * is per account; without them, `get` resolves it through filecoin-api.
 */
function localResource(app: App, target: string): Resource | undefined {
  if (target.startsWith('res_')) return findResource(app, target)
  if (!resolveCredentials(app)) return undefined
  return findResourcesByCid(app.db(), accountScope(app), target)[0]
}

/** A retryable `not_found` for a root Curio has not indexed yet. */
function notIndexed(resource: Resource, target: string): CliError {
  return new CliError({
    code: ErrorCodes.notFound,
    message: `The provider has not indexed ${resource.rootCid} yet. Curio serves /ipfs a few minutes after the commit.`,
    retryable: true,
    retryAfterSeconds: INDEX_RETRY_SECONDS,
    next: [
      {
        by: 'agent',
        command: `filecoin get ${target}`,
        description: 'Retry in a minute',
      },
      {
        by: 'agent',
        command: `filecoin get ${resource.pieceCid}`,
        description: 'Download the stored CAR instead, checked by PieceCID',
      },
    ],
  })
}

/**
 * Retrieve and verify a target. What the target names decides what `get`
 * returns:
 *
 * - A PieceCID gets the exact stored bytes, checked against the PieceCID,
 *   from Curio `/piece`. For a file or folder stored as a CAR, that is the CAR.
 * - A root CID, or the ref of a resource with one, gets the extracted file or
 *   folder from Curio `/ipfs`, checked block by block as it streams.
 * - A ref of a raw file gets its bytes from `/piece`.
 *
 * Managed resources come from local state and their first copy's provider.
 * Any other CID resolves through filecoin-api `/get/{cid}`, which redirects
 * to a provider.
 *
 * @see ../../../../docs/filecoin/architecture.md#the-get-flow
 */
export default defineHandler(get, async (ctx) => {
  const { input } = ctx
  const app = await appFor(ctx)
  const { target } = input
  const resource = localResource(app, target)

  if (!resource) {
    const pieceCid = Piece.tryFrom(target)?.toString()
    const url = getUrl(app.apiUrl, app.network, pieceCid ?? target)
    if (pieceCid) {
      const output = resolve(input.output ?? target)
      await assertWritable(output, input.force)
      const piece = await downloadPiece({
        url,
        pieceCid,
        output,
        signal: ctx.signal,
      })
      return ctx.ok({ kind: 'file', pieceCid, output, ...piece })
    }
    let rootCid: string
    try {
      // filecoin-api and Curio name roots in CIDv1.
      rootCid = CID.parse(target).toV1().toString()
    } catch {
      throw notFound(`No managed resource, PieceCID, or CID ${target}.`, {
        by: 'agent',
        command: 'filecoin ls',
        description: "List the wallet's stored pieces and their refs",
      })
    }
    const output = resolve(input.output ?? target)
    const dag = await downloadDag({
      url,
      rootCid,
      output,
      overwrite: input.force,
      notFound: () => notFound(`No provider serves ${rootCid}.`),
      signal: ctx.signal,
    })
    return ctx.ok({
      kind: dag.kind,
      rootCid,
      output,
      size: dag.size,
      ...(dag.kind === 'folder' ? { files: dag.files } : {}),
      url: dag.url,
    })
  }

  const wantsPiece = target === resource.pieceCid
  if (resource.rootCid && !wantsPiece) {
    const output = resolve(input.output ?? resource.name)
    const dag = await downloadDag({
      url: providerIpfsUrl(resource),
      rootCid: resource.rootCid,
      output,
      overwrite: resource.kind === 'file' && input.force,
      notFound: () => notIndexed(resource, target),
      signal: ctx.signal,
    })
    return ctx.ok({
      kind: resource.kind,
      ref: resource.ref,
      pieceCid: resource.pieceCid,
      rootCid: resource.rootCid,
      output,
      size: dag.size,
      ...(resource.kind === 'folder' ? { files: dag.files } : {}),
      url: dag.url,
    })
  }

  const output = resolve(
    input.output ?? (resource.rootCid ? `${resource.name}.car` : resource.name)
  )
  await assertWritable(output, input.force)
  const piece = await downloadPiece({
    url: providerPieceUrl(resource),
    pieceCid: resource.pieceCid,
    output,
    notFound: () =>
      notFound(`The provider does not have ${resource.pieceCid}.`),
    signal: ctx.signal,
  })
  return ctx.ok({
    kind: 'file',
    ref: resource.ref,
    pieceCid: resource.pieceCid,
    output,
    ...piece,
  })
})

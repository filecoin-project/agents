import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as Piece from '@filoz/synapse-core/piece'
import { CliError } from 'clipact'
import { ErrorCodes, notFound } from '../errors.ts'

/** Options for {@link fetchContent}. */
export type FetchContentOptions = {
  /** `Accept` header to send; it is kept across redirects. */
  accept?: string | undefined
  /** Error for a 404; defaults to `not_found` naming the URL. */
  notFound?: (() => CliError) | undefined
  fetch?: typeof globalThis.fetch | undefined
  signal?: AbortSignal | undefined
}

/**
 * Fetch retrieval content, following redirects such as filecoin-api's
 * `/get/{cid}`, and map failures to CLI errors: a 404 to `not_found`, a
 * 429 to `rate_limited`, and anything else that fails to
 * `service_unavailable`. Returns a response with a body.
 *
 * @see ../../../../docs/filecoin/retrieval.md
 */
export async function fetchContent(
  url: string,
  options: FetchContentOptions = {}
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const response = await fetchFn(url, {
    signal: options.signal,
    ...(options.accept ? { headers: { accept: options.accept } } : {}),
  }).catch((error: unknown) => {
    if (options.signal?.aborted) throw error
    throw new CliError({
      code: 'service_unavailable',
      message: `Could not reach ${url}.`,
      cause: error,
    })
  })
  if (response.ok && response.body) {
    return response as Response & { body: ReadableStream<Uint8Array> }
  }
  await response.body?.cancel()
  const at = response.url || url
  if (response.status === 404) {
    throw options.notFound?.() ?? notFound(`${at} returned HTTP 404.`)
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new CliError({
      code: 'rate_limited',
      message: `${at} limited the request rate.`,
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterSeconds: retryAfter }
        : {}),
    })
  }
  throw new CliError({
    code: 'service_unavailable',
    message: `Retrieval from ${at} failed with HTTP ${response.status}.`,
  })
}

/** Options for {@link downloadPiece}. */
export type DownloadPieceOptions = {
  /** Curio `/piece/{pieceCid}`, or a filecoin-api `/get/{pieceCid}` URL. */
  url: string
  pieceCid: string
  /** Final file path; written only after the PieceCID matches. */
  output: string
  /** Error for a 404; defaults to one saying no provider has the piece. */
  notFound?: () => CliError
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

/**
 * Stream a piece to `output` while hashing it, and keep the file only when
 * the bytes match the expected PieceCID. synapse-core's `Piece.downloadStream`
 * validates the same way, but its `DownloadPieceError` drops the HTTP status,
 * so a 404 could not become `not_found`. Returns the size and the URL the
 * bytes came from, after redirects.
 */
export async function downloadPiece(
  options: DownloadPieceOptions
): Promise<{ size: number; url: string }> {
  const response = await fetchContent(options.url, {
    notFound:
      options.notFound ??
      (() => notFound(`No provider serves ${options.pieceCid}.`)),
    fetch: options.fetch,
    signal: options.signal,
  })
  const output = resolve(options.output)
  await mkdir(dirname(output), { recursive: true })
  const tmp = `${output}.filecoin-partial`
  const hasher = Piece.hasher()
  const hash = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      hasher.write(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      hash,
      createWriteStream(tmp)
    )
    const actual = hasher.finalize().toString()
    if (actual !== options.pieceCid) {
      throw new CliError({
        code: ErrorCodes.verificationFailed,
        message: `Downloaded bytes hash to ${actual}, expected ${options.pieceCid}.`,
      })
    }
    await rename(tmp, output)
    return { size: Number(hasher.count()), url: response.url || options.url }
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Error returned when `get` would overwrite an existing path. */
export function outputExists(path: string): CliError {
  return new CliError({
    code: ErrorCodes.outputExists,
    message: `${path} already exists.`,
    next: [
      {
        by: 'agent',
        description:
          'Choose another path with --output, or pass --force for a file',
      },
    ],
  })
}

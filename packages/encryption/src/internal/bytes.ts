/**
 * Byte and stream helpers shared by the modules. Runtime-neutral: Web Streams
 * and WebCrypto only.
 *
 * @module
 */

import { base64url } from 'multiformats/bases/base64'
import { privateKeyToAccount } from 'viem/accounts'

/** Unpadded base64url characters. */
export const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * Unpadded base64url of `bytes`, as Grants, share links, and Access keys
 * write them.
 *
 * @param bytes - The bytes to encode.
 * @see https://www.rfc-editor.org/rfc/rfc4648#section-5
 */
export function toBase64url(bytes: Uint8Array): string {
  return base64url.baseEncode(bytes)
}

/**
 * The bytes of unpadded base64url text, or undefined when the text holds any
 * other character or has a length no encoding gives (4k + 1).
 *
 * @param text - Unpadded base64url.
 */
export function fromBase64url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text)) return undefined
  try {
    return base64url.baseDecode(text)
  } catch {
    return undefined
  }
}

/**
 * Whether two Ethereum addresses are equal, ignoring case.
 *
 * @param a - An address.
 * @param b - Another address.
 */
export const sameAddress = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase()

/** A byte source this package reads: a Web stream, any async or sync iterable of chunks, or the bytes themselves. */
export type ByteSource =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | Uint8Array

/**
 * `source` as an async iterable. A `ReadableStream` is read through its reader,
 * because not every browser makes streams async iterable.
 *
 * @param source - The bytes to read.
 */
export async function* iterate(source: ByteSource): AsyncGenerator<Uint8Array> {
  // A Uint8Array is an iterable of numbers, not of chunks: it is one chunk.
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  if (!(source instanceof ReadableStream)) {
    yield* source
    return
  }
  const reader = source.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * `source` as a `ReadableStream` that pulls one chunk per read, so nothing
 * runs ahead of the consumer.
 *
 * @param source - The bytes to stream.
 */
export function toStream(source: ByteSource): ReadableStream<Uint8Array> {
  if (source instanceof ReadableStream) return source
  const iterator = iterate(source)
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await iterator.next()
        if (done === true) controller.close()
        else controller.enqueue(value)
      },
      async cancel(reason) {
        await iterator.return(reason)
      },
    },
    { highWaterMark: 0 }
  )
}

/**
 * The account of a secp256k1 private key written as `0x` and 64 hex digits,
 * or undefined for anything else, a zero key or one past the curve order
 * included. viem itself drops a key's first two characters unchecked, and
 * its errors repeat the key.
 *
 * @param key - The private key.
 */
export function accountOf(
  key: string
): ReturnType<typeof privateKeyToAccount> | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined
  try {
    return privateKeyToAccount(key as `0x${string}`)
  } catch {
    return undefined
  }
}

/**
 * Pass `readable` through, run `end` exactly once when it closes, errors, or is
 * cancelled, and replace any error with `mapError(error)`. `end` runs as soon
 * as `readable` closes, even before the last chunk is read from the wrapper. Used to wipe a key
 * once the stream that borrows it is done.
 *
 * @param readable - The stream to wrap.
 * @param end - Runs once the stream is done, however it ends.
 * @param mapError - Turns an error into one that is safe to print.
 */
export function guarded(
  readable: ReadableStream<Uint8Array>,
  end: () => void,
  mapError: (error: unknown) => unknown
): ReadableStream<Uint8Array> {
  const reader = readable.getReader()
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    end()
  }
  // FEE closes its stream with the last chunk: a reader that stops at the last byte never pulls a `done`.
  reader.closed.then(finish, finish)
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>
        try {
          result = await reader.read()
        } catch (error) {
          finish()
          throw mapError(error)
        }
        if (result.done) {
          finish()
          controller.close()
        } else {
          controller.enqueue(result.value)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    },
    { highWaterMark: 0 }
  )
}

/**
 * `bytes` as WebCrypto takes them: the view itself, or a copy when it is over
 * a `SharedArrayBuffer`, which WebCrypto refuses.
 *
 * @param bytes - The bytes to hash.
 */
export function hashable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)
}

/**
 * The SHA-256 digest of `bytes`, with WebCrypto.
 *
 * @param bytes - The bytes to hash.
 */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', hashable(bytes)))
}

/**
 * Whether two byte arrays hold the same bytes.
 *
 * @param a - Bytes.
 * @param b - Other bytes.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

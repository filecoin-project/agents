/**
 * In-memory implementations of the packer's and unpacker's file system
 * interfaces, and stream helpers, for tests.
 */

import type {
  InnerCarInput,
  InputEntry,
  InputSource,
  UnpackSink,
  UnpackTree,
} from '../src/car/index.ts'

/** A file or folder held in memory: path to bytes, or to `null` for a directory. */
export type MemoryTree = Record<string, Uint8Array | string | null>

const bytesOf = (value: Uint8Array | string): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value

/**
 * The input and the source for an in-memory tree, whose keys start with the
 * input's name. Entries are sorted as a walk lists them.
 */
export function memoryInput(tree: MemoryTree): {
  input: InnerCarInput
  source: InputSource
} {
  const paths = Object.keys(tree).sort()
  const name = paths[0]?.split('/')[0] ?? ''
  const single = paths.length === 1 && tree[name] != null
  const input: InnerCarInput = single
    ? { type: 'file', name, size: bytesOf(tree[name] as Uint8Array).length }
    : {
        type: 'directory',
        name,
        entries: paths
          .filter((path) => path !== name)
          .map((path): InputEntry => {
            const rel = path.slice(name.length + 1)
            const value = tree[path]
            return value == null
              ? { type: 'directory', path: rel }
              : { type: 'file', path: rel, size: bytesOf(value).length }
          }),
      }
  const file = (rel: string): Uint8Array => {
    const path = rel === '' ? name : `${name}/${rel}`
    const value = tree[path]
    if (value == null)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return bytesOf(value)
  }
  return {
    input,
    source: {
      async *stream(path) {
        const bytes = file(path)
        const chunks: Uint8Array[] = []
        for (let i = 0; i < bytes.length; i += 300_000)
          chunks.push(bytes.subarray(i, i + 300_000))
        for await (const chunk of chunks) yield chunk
      },
      read(path, offset, length) {
        return Promise.resolve(file(path).slice(offset, offset + length))
      },
    },
  }
}

/** A sink that writes into memory, and what it wrote. */
export function memorySink(): UnpackSink & {
  tree?: UnpackTree
  files: Map<string, Uint8Array>
  dirs: string[]
} {
  const sink = {
    tree: undefined as UnpackTree | undefined,
    files: new Map<string, Uint8Array>(),
    dirs: [] as string[],
    begin(tree: UnpackTree) {
      sink.tree = tree
      sink.dirs = [...tree.dirs]
      for (const f of tree.files) sink.files.set(f.path, new Uint8Array(f.size))
    },
    write(path: string, offset: number, bytes: Uint8Array) {
      const file = sink.files.get(path)
      if (file == null) throw new Error('write to a file begin did not create')
      file.set(bytes, offset)
    },
  }
  return sink
}

/** Every byte of a stream or iterable, concatenated. */
export async function collect(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  if (source instanceof ReadableStream) {
    const reader = source.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } else {
    for await (const chunk of source) chunks.push(chunk)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** UTF-8 text of bytes. */
export const text = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes)

/** The bytes of filecoin-pin's big golden input: 1.1 MB of `(i * 7919 + (i >> 8)) & 0xff`. */
export function bigInput(): Uint8Array {
  const out = new Uint8Array(1_100_000)
  for (let i = 0; i < out.length; i++) out[i] = (i * 7919 + (i >> 8)) & 0xff
  return out
}

/** A Web stream of `bytes`. */
export const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()

/**
 * `n` random bytes from WebCrypto, which fills at most 65,536 bytes a call.
 * See {@link https://developer.mozilla.org/docs/Web/API/Crypto/getRandomValues | getRandomValues}.
 *
 * @param n - How many bytes.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65_536)
    crypto.getRandomValues(out.subarray(i, i + 65_536))
  return out
}

/** The bytes of `parts`, one after another, in a new buffer. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Whether `a` and `b` hold the same bytes. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/** Whether `needle` occurs anywhere in `haystack`. */
export function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** Lowercase hex of `bytes`, without `0x`. */
export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Kept in a variable, so a browser bundle doesn't try to resolve it. */
const NODE_FS = 'node:fs/promises'

/**
 * A file under `test/fixtures/filecoin-pin/`. playwright-test serves the
 * package folder and names the server in `PW_SERVER`, in browsers and in its
 * node mode. Plain `node --test` reads the file from disk.
 * See {@link https://github.com/hugomrdias/playwright-test#http-server | playwright-test's HTTP server}.
 *
 * @param name - The fixture's file name.
 */
export async function fixture(name: string): Promise<Uint8Array> {
  const server = process.env.PW_SERVER
  if (server != null && server !== '') {
    const response = await fetch(`${server}/test/fixtures/filecoin-pin/${name}`)
    if (!response.ok)
      throw new Error(`fixture ${name}: HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  const fs = (await import(NODE_FS)) as typeof import('node:fs/promises')
  return new Uint8Array(
    await fs.readFile(
      new URL(`./fixtures/filecoin-pin/${name}`, import.meta.url)
    )
  )
}

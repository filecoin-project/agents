import { CarIndexedReader, CarWriter } from '@ipld/car'
import * as DagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'

/** A block of a CAR stream. */
export type Block = { cid: CID; bytes: Uint8Array }

/**
 * Read the blocks of a CAR at `carPath` depth-first from the root, parent
 * before children, links in order. By default every repeated block is sent
 * again, as Curio's `/ipfs` endpoint (frisbii) does. With `dups: false`,
 * each block comes once, where the walk first meets it, as Kubo's
 * `dag export` writes it.
 *
 * @see https://github.com/ipld/frisbii
 */
export async function* dfsBlocks(
  carPath: string,
  { dups = true }: { dups?: boolean } = {}
): AsyncGenerator<Block> {
  const reader = await CarIndexedReader.fromFile(carPath)
  try {
    const [root] = await reader.getRoots()
    if (!root) throw new Error('CAR has no root.')
    const stack = [CID.decode(root.bytes)]
    const seen = new Set<string>()
    for (let cid = stack.pop(); cid; cid = stack.pop()) {
      // A repeat's children are repeats too, so the whole subtree is skipped.
      if (!dups && seen.has(cid.toString())) continue
      seen.add(cid.toString())
      const block = await reader.get(cid)
      if (!block) throw new Error(`Block ${cid} missing from CAR.`)
      yield { cid, bytes: block.bytes }
      if (cid.code === DagPb.code) {
        const links = DagPb.decode(block.bytes).Links
        for (const link of [...links].reverse()) {
          stack.push(CID.decode(link.Hash.bytes))
        }
      }
    }
  } finally {
    await reader.close()
  }
}

/** Encode blocks as a CARv1 stream with `root` in its header. */
export async function* carStream(
  root: CID,
  blocks: AsyncIterable<Block> | Iterable<Block>
): AsyncGenerator<Uint8Array> {
  const { writer, out } = CarWriter.create([root])
  const writing = (async () => {
    for await (const block of blocks) await writer.put(block)
    await writer.close()
  })()
  yield* out
  await writing
}

/**
 * A `fetch` that answers every request with `body` as a depth-first CAR,
 * the way Curio's `/ipfs` endpoint does, and records the `Accept` header.
 * The response stream errors when the request's signal aborts.
 */
export function carFetch(
  body: () => AsyncIterable<Uint8Array>,
  init: { status?: number; contentType?: string } = {}
): typeof fetch & { accepts: (string | null)[] } {
  const accepts: (string | null)[] = []
  const fn = async (_input: RequestInfo | URL, request?: RequestInit) => {
    accepts.push(new Headers(request?.headers).get('accept'))
    const status = init.status ?? 200
    if (status !== 200) return new Response(null, { status })
    // Read the whole body first, so no producer outlives a failed test.
    const chunks: Uint8Array[] = []
    for await (const chunk of body()) chunks.push(chunk)
    const signal = request?.signal
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason))
      },
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
    })
    return new Response(stream, {
      headers: {
        'content-type':
          init.contentType ??
          'application/vnd.ipld.car;version=1;order=dfs;dups=y',
      },
    })
  }
  return Object.assign(fn, { accepts }) as typeof fetch & {
    accepts: (string | null)[]
  }
}

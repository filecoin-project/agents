import { defineCommand } from 'clipact'
import * as z from 'zod'
import { ErrorCodes, STORAGE_ERRORS } from '../errors.ts'
import { account, accountEnv, resource, storedPiece, urls } from './shared.ts'

/**
 * `filecoin inspect <target>`: show a ref, PieceCID, root CID, or
 * `<dataSetId>/<pieceId>` with the wallet's pieces filecoin-api has for it.
 */
export const inspect = defineCommand({
  name: 'inspect',
  description: "Show a resource or piece and the wallet's indexed copies",
  examples: [
    'filecoin inspect res_abc123',
    'filecoin inspect 39723/0',
    'filecoin inspect bafybei… --check',
  ],
  input: z.strictObject({
    target: z
      .string()
      .describe(
        'Resource ref (res_…), PieceCID, root CID, or <dataSetId>/<pieceId>'
      ),
    check: z
      .boolean()
      .default(false)
      .describe('Probe the piece URL with a HEAD request'),
    ...account,
  }),
  positionals: ['target'],
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    network: z.string(),
    resource: resource
      .optional()
      .describe('Managed resource the target names, from local state'),
    pieces: z
      .array(storedPiece)
      .describe(
        "The wallet's pieces filecoin-api has for the target, removed ones included; empty until its indexer has a new put"
      ),
    urls: urls
      .optional()
      .describe('Absent when filecoin-api has no PieceCID for the piece'),
    retrieval: z
      .object({
        url: z.string(),
        state: z.enum(['ready', 'unavailable']),
        status: z.number().int().describe('HTTP status; 0 when unreachable'),
        checkedAt: z.string(),
      })
      .optional(),
  }),
  errors: [
    ...STORAGE_ERRORS,
    ErrorCodes.authRequired,
    ErrorCodes.loginPending,
    ErrorCodes.notFound,
  ],
  readOnly: true,
  human: ({ resource: r, pieces, urls: u, retrieval }) =>
    [
      ...(r ? [`${r.ref} ${r.kind} ${r.name} (${r.status})`] : []),
      ...(r ? [`pieceCid: ${r.pieceCid}`] : []),
      ...(r?.rootCid ? [`rootCid: ${r.rootCid}`] : []),
      ...(u ? [`piece: ${u.piece}`, `browser: ${u.browser}`] : []),
      ...(pieces.length === 0
        ? ['pieces: not indexed yet']
        : pieces.map((p) =>
            [
              `${p.dataSetId}/${p.pieceId}`.padEnd(12),
              p.providerId ? `provider ${p.providerId}` : '',
              p.name ?? '',
              p.resourceRef ?? '',
              r ? '' : (p.rootCid ?? p.pieceCid ?? ''),
              p.removed ? 'removed' : '',
            ]
              .filter(Boolean)
              .join('  ')
          )),
      ...(retrieval
        ? [`retrieval: ${retrieval.state} (HTTP ${retrieval.status})`]
        : []),
    ].join('\n'),
  handler: () => import('../handlers/inspect.ts'),
})

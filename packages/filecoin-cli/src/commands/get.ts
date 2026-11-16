import { defineCommand } from 'clipact'
import * as z from 'zod'
import { ErrorCodes, STORAGE_ERRORS } from '../errors.ts'
import { account, accountEnv, formatBytes } from './shared.ts'

/**
 * `filecoin get <target>`: download and verify a resource, a PieceCID, or an
 * IPFS CID. A PieceCID gets the exact stored bytes, checked against it. A
 * root CID, or the ref of a file or folder stored as a CAR, gets the
 * extracted file or folder, checked block by block.
 *
 * @see ../../../../docs/filecoin/architecture.md#the-get-flow
 */
export const get = defineCommand({
  name: 'get',
  description:
    'Download and verify a resource (by ref, PieceCID, or IPFS root CID)',
  examples: [
    'filecoin get res_abc123',
    'filecoin get res_abc123 --output ./copy',
    'filecoin get bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  ],
  input: z.strictObject({
    target: z
      .string()
      .describe('Resource ref (res_…), PieceCID, or IPFS root CID'),
    output: z
      .string()
      .optional()
      .describe(
        'Output path (default: the resource name, with .car for the PieceCID of a CAR; else the CID)'
      ),
    force: z.boolean().default(false).describe('Overwrite an existing file'),
    ...account,
  }),
  positionals: ['target'],
  env: accountEnv,
  secrets: ['sessionKey'],
  output: z.object({
    kind: z.enum(['file', 'folder']),
    ref: z.string().optional(),
    pieceCid: z
      .string()
      .optional()
      .describe(
        'PieceCID, when known; the bytes were checked against it if rootCid is absent'
      ),
    rootCid: z
      .string()
      .optional()
      .describe(
        'IPFS root CID the blocks were checked against, for extracted content'
      ),
    output: z.string().describe('Written file or directory'),
    size: z
      .number()
      .int()
      .describe('Verified bytes downloaded: the piece, or the CAR of a root'),
    files: z.number().int().optional().describe('Files extracted'),
    url: z.string().describe('URL the bytes came from, after redirects'),
  }),
  errors: [
    ...STORAGE_ERRORS,
    ErrorCodes.authRequired,
    ErrorCodes.loginPending,
    ErrorCodes.notFound,
    ErrorCodes.outputExists,
    ErrorCodes.verificationFailed,
    ErrorCodes.unsafePath,
  ],
  idempotent: true,
  human: (data) =>
    `Wrote ${data.output} (${formatBytes(data.size)}${data.files == null ? '' : `, ${data.files} files`}), verified against ${data.rootCid ?? data.pieceCid}`,
  handler: () => import('../handlers/get.ts'),
})

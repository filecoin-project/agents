import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { CliError } from 'clipact'
import type {
  DirectoryCandidate,
  FileCandidate,
  ImporterOptions,
} from 'ipfs-unixfs-importer'
import { equals } from 'multiformats/bytes'
import type { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { ErrorCodes, invalidInput } from '../errors.ts'

/**
 * The single UnixFS profile used for every CAR: IPIP-499
 * `unixfs-v1-2025` (CIDv1, raw leaves, 1 MiB chunks), matching Filecoin Pin.
 *
 * @see https://github.com/ipfs/specs/pull/499
 */
export const IMPORTER_OPTIONS: ImporterOptions = { profile: 'unixfs-v1-2025' }

/** A file included in a folder, relative to the packed directory. */
export type PackEntry = { path: string; size: number }

/**
 * List the files and directories to pack, sorted for a deterministic DAG.
 * Dotfiles and dot-directories are skipped. Symlinks are rejected rather than
 * followed, so a publication never reaches outside the chosen directory.
 */
export async function listEntries(
  root: string
): Promise<{ files: PackEntry[]; directories: string[] }> {
  const files: PackEntry[] = []
  const directories: string[] = []
  async function walk(dir: string): Promise<void> {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      const stats = await lstat(path)
      const rel = relative(root, path).split(sep).join('/')
      if (stats.isSymbolicLink()) {
        throw invalidInput(`Symlinks are not supported: ${rel}`, 'path')
      }
      if (stats.isDirectory()) {
        directories.push(rel)
        await walk(path)
      } else if (stats.isFile()) {
        files.push({ path: rel, size: stats.size })
      }
    }
  }
  await walk(root)
  return { files, directories }
}

/**
 * Importer candidates for the directory at `root`, named `name`, from its
 * {@link listEntries} result. Each file candidate reads its source lazily.
 *
 * Parent directories are created from file paths. Passing them explicitly
 * makes the importer also emit an orphan empty-directory block, so only
 * empty directories (and an empty root) are passed as candidates.
 */
export function* directoryCandidates(
  root: string,
  name: string,
  files: PackEntry[],
  directories: string[]
): Generator<FileCandidate | DirectoryCandidate> {
  const parents = new Set(
    [...files.map((f) => f.path), ...directories].map((path) =>
      path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    )
  )
  if (!parents.has('')) yield { path: name }
  for (const directory of directories) {
    if (!parents.has(directory)) yield { path: `${name}/${directory}` }
  }
  for (const file of files) {
    yield {
      path: `${name}/${file.path}`,
      content: createReadStream(join(root, file.path)),
    }
  }
}

/** Multihash code for identity CIDs, whose digest is the block itself. */
export const IDENTITY_CODE = 0x00

/**
 * Check that a block's bytes hash to its CID, like ipfs-car's `--verify`.
 * A CAR verified by PieceCID is already exact, but a CAR rebuilt by a
 * gateway (for example Curio `/ipfs/…?format=car`) is only trustworthy
 * block by block.
 *
 * @see https://github.com/storacha/ipfs-car
 */
export async function assertBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  const { code, digest } = cid.multihash
  let actual: Uint8Array
  if (code === sha256.code) {
    actual = (await sha256.digest(bytes)).digest
  } else if (code === IDENTITY_CODE) {
    actual = bytes
  } else {
    throw new CliError({
      code: ErrorCodes.verificationFailed,
      message: `Unsupported multihash 0x${code.toString(16)} in block ${cid}.`,
    })
  }
  if (!equals(actual, digest)) {
    throw new CliError({
      code: ErrorCodes.verificationFailed,
      message: `Block ${cid} does not match its CID.`,
    })
  }
}

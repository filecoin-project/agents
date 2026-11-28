# @filecoin-project/encryption

Filecoin's encrypted upload format, Keysmith format 2, as one package that a client calls instead of copying the rules. It covers group key choice and the `foc/enc` data set metadata, the `fgr1_` Grant text and its checks, the FEE envelope, the metadata-first inner CAR, random-access reads of one file, and share links.

It runs in browsers and in Node.js. It uses Web Streams and WebCrypto, and it imports no `node:*` module. The caller owns the file system: it lists the input, reads bytes, and writes output through two small interfaces, `InputSource` and `UnpackSink`.

```sh
npm install @filecoin-project/encryption viem
```

[Encryption with FEE and Keysmith](../../docs/filecoin/encryption.md) explains FEE, Keysmith, and filecoin-pin's design. This README covers the package.

## What it exports

The root export holds everything. Each part is also a subpath export:

| Subpath      | Contents                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/group-key` | The `foc/enc` `"1"`, `foc/gkid`, `foc/kc`, and legacy `foc/ks` keys, `isEncryptedDataSet`, `defaultGroupKeyId`, `chooseGroupKey` (the oldest valid group key, else the default one; it skips a group key whose `foc/kc` isn't `v2.` and 32 lowercase hex, and its `GroupKeyChoiceError` carries the clashing `dataSetIds`), `encryptedDataSetMetadata`, `checkGroup`, `format1Message`                          |
| `/grant`     | The `fgr1_` codec (`decodeGrantText`, `grantText`, `splitGrants`, `joinGrants`), `openGrant` with its owner, network, session key, group key, node, and expiry checks, `precheckGrant`, `keyAgreementParams` and `grantLinkParams` for the console link, `parseGrantLinkParams`, which reads them with the console's rules, `verifyKeyAgreementKey`, and `issueGrant`, which issues a Grant as the console does |
| `/envelope`  | `encrypt`, `encryptPlan`, `decrypt`, `decryptToSink`, `readEnvelopeHeader` and `isEnvelope`, the key resolvers (`ownerKeyResolver`, `grantKeyResolver`, `credentialKeyResolver`), `toDecryptError`, `wrapOverhead`, and the constants `ENCRYPTED_FILE_NAME` (`encrypted.fee`), `CAR_CONTENT_TYPE`, and `CHUNK_SIZE` (256 KiB)                                                                                   |
| `/car`       | `planInnerCar` and `emitInnerCar`, which write the inner CAR in two passes, `unpackInnerCar`, which reads it in one streaming pass, `layout`, with each file's leaves and the work, depth, and size limits, and `isUnsafeName`                                                                                                                                                                                  |
| `/archive`   | `openArchive`, which lists an upload's tree and decrypts one file at a time over a FEE `RandomAccessSource`, such as HTTP range requests                                                                                                                                                                                                                                                                        |
| `/share`     | `createShare`, `parseShareLink`, `formatShareLink`, `accessKeyText`, `parseAccessKey`, `shareKey`, `shareOwner`, and `shareKeyResolver`, for `#v1/` links and `fak1_` Access keys. A link's payload can be a plain piece Grant or a Delivery, which can expire                                                                                                                                                  |
| `/errors`    | `EncryptionError` and its subclasses, each with a stable `code`                                                                                                                                                                                                                                                                                                                                                 |

Gated `/download` reads, with `Authorization: FOC-Grant` headers, are not in the package.

## Credentials

A writer or a reader holds a key in one of two ways, the `Credentials` type:

- `{ owner }` is the owner wallet, a viem account or any signer with `address` and `signTypedData`. It derives every key from one `GroupKey` signature. A write to a group key that already has data sets signs once and checks the key against `foc/kc`. A new group key, and every read, signs twice.
- `{ session }` is a session key with the `fgr1_` Grants it stores, the owner address that authorized it, the chain id, and the saved group key id. The package opens the Grants only when it needs a key, skips one that no longer opens (`onIgnored` hears about it), and picks the narrowest Grant that reaches the piece or group.

No function returns a group key or a Grant's key, and the package stores no key. It zeroes a group key or a Grant's key as soon as the piece key is derived. That covers the keys the package receives. Keysmith 0.2.0 zeroes none of the buffers it uses inside its own calls, such as the signature bytes, the keys between a group key and a nested group's key, and the keys `wrapTo` and `unwrapWith` wrap with, and the package never gets a reference to them. Keysmith also drops three keys unzeroed when a call fails: the group key `deriveGroupKey` derives before its commitment check fails, the key `openDelivery` unwraps before its commitment check fails, and the node key `rootClaim` derives before the wallet refuses to sign. `decrypt` and `decryptToSink` keep the piece key inside the FEE stream and zero it when that stream closes, fails, or is cancelled. An archive from `openArchive` keeps its piece key for its reads and zeroes it on `close()`, or when opening fails. The key resolvers are the one place a piece key leaves the package: the function a resolver returns hands it to its caller. Inside `decrypt` that caller is FEE. A caller that calls the function itself owns the key and must zero it. For a range read, call it with the `EnvelopeInfo` from FEE's `parse`, pass the key to FEE's `decryptRange`, and zero it in a `finally` once that call settles. FEE imports the key before `decryptRange` resolves. Every encryption derives a fresh piece key under a fresh salt, so the same input never encrypts to the same envelope twice.

## Errors

Every error is an `EncryptionError` with a stable `code` and a message that is safe to print. A message never holds a plaintext name, path, or CID, nor an invalid address the caller passed, which could be a private key pasted by mistake. An error code copied from another error must look like one, such as `ENOSPC`. It may hold public values: an envelope's owner and group key id, a Grant's expiry, an entry's position in the caller's list (`entry #3`), or a size. A packing error names its entry by position only, so the CLI can point the user to `filecoin put <your folder> --dry-run` to list names. The subclasses are `KeyAccessError` (with `NotOwnerError`, `GrantError`, and `ShareLinkError`), `InputError`, `InnerCarError`, `DecryptError`, and `GroupKeyChoiceError`. `decrypt`, `decryptToSink`, `openArchive`, and `toDecryptError` turn every failure into a `DecryptError`. One from this package keeps its code and message, such as `not-owner` or `expired` for a wrong key. Any other error, such as a wallet that refused to sign or a sink's `ENOSPC`, becomes `decrypt-failed`, with only its code in the message and the original as `cause`. A write does the same with `encrypt-failed`, `issueGrant` with `issue-failed`, and `createShare` with `share-failed`. An invalid limit option, such as a `NaN` or negative `maxMetadataBytes`, throws a `RangeError`.

A caller attaches its own next step by code. For example, `no-grant` and `expired` mean that the user needs a new Grant from the console, and `share-expired` that the recipient needs a new link. Only `incomplete-download`, a range response that ended early, and `truncated`, a stream download cut short, are worth retrying as they are. `openArchive` reads an envelope of another size than its header commits to as `wrong-key-or-modified`, because its source's size is the stored upload's. A stream with more bytes than its header declares is `wrong-key-or-modified` too.

## Read one file

`openArchive` takes the envelope as a FEE `RandomAccessSource`, such as one over HTTP range requests, or as bytes. It decrypts only the inner CAR's metadata, then decrypts each file you open, checking every leaf's section and its bytes against its CID. It refuses an inner CAR that isn't exactly what an encrypted put writes. A file holds one batch of decrypted sections at a time, so a repeated chunk whose first use is more than one batch back is decrypted again. `close()` zeroes the piece key and cancels the range reads still running. A read that is running when you close the archive releases nothing more:

```ts
import { openArchive } from '@filecoin-project/encryption/archive'
import {
  parseShareLink,
  shareKey,
  shareKeyResolver,
} from '@filecoin-project/encryption/share'

const share = parseShareLink(link)
const archive = await openArchive(
  source,
  shareKeyResolver(share, shareKey(share, accessKey))
)
try {
  for (const entry of archive.list()) console.log(entry.path, entry.size)
  // open() is lazy: read the stream before close(), or the read fails as archive-closed.
  await archive.open(`${archive.name}/notes/a.md`).pipeTo(destination)
} finally {
  archive.close() // zeroes the piece key
}
```

## How the CLI would call it

These sketches show `filecoin put --encrypt` and `filecoin get` calling the package. The CLI's own parts, such as `listEntries`, `downloadDag`, the `.filecoin-partial` path, and the config file, stay in the CLI. [What the CLI has to match](../../docs/filecoin/encryption.md#what-the-cli-has-to-match) lists the rules behind them.

### Log in with a Grant

`filecoin login` adds the Grant parameters to its `/console/setup` link, which also carries `authorize`, `network`, and `scopes` with `addPieces`. Then it imports the `fgr1_…` text that the owner pastes. It saves the text and the group key id next to the session key, never the key the Grant opens:

```ts
import { grantLinkParams, openGrant } from '@filecoin-project/encryption/grant'

const params = await grantLinkParams({ sessionKey, group }) // pubkey, pubkeysig, node, maxdepth=0
const info = await openGrant(pastedText, { sessionKey, walletAddress, chainId })
config.grant = {
  text: info.text,
  groupKeyId: info.groupKeyId,
  expires: info.expires,
}
```

### `put --encrypt`

Pass 1 plans the inner CAR from the CLI's own walk. Encrypted put uses `listEntries`, the same walk as a plain put, so it refuses symlinks, names with `\`, and special files, and skips dotfiles unless `--include-hidden` is passed. The CLI reports a walk failure with counts by kind and no names. The wrapper's one entry is `basename(resolve(input))`, passed explicitly as `name`, never `--name`. Pass 2 streams it through FEE into a staged `encrypted.fee`. Encryption isn't deterministic, so the CLI stages the envelope before the first upload, and `operations resume` uploads the same bytes. The outer CAR is the single-file DFS CAR that `dfs-car.ts` already writes, and it is deterministic from the staged envelope. Pass 1 fails as `too-large` for a tree whose metadata is over the package readers' 16 MiB default, whose files add up to more than the 64 GiB they restore by default, or whose inner CAR FEE can't encode in one 64 GiB object with its header and chunk tags. It fails as `bad-entries` for a tree past another reader limit, such as paths that add up to more than 128 MiB. The share link viewer also refuses an archive of more than 10,000 entries, which pass 1 doesn't check. Pass 1 fails as `changed` if a file's size differs from the walk's, as filecoin-pin does. When one file fails, pass 1 stops reading the others. It calls `return()` on each read and aborts the `signal` passed to `source.stream`. An async generator can't end a pending read on `return()`, so a source written as one must end it on that signal, or the failure waits for the read. Pass 2 fails as `changed` if a file changed, shrank, or grew since pass 1, so `source.read` must return fewer bytes at a file's end, as `FileHandle.read` does:

```ts
import { createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { planInnerCar } from '@filecoin-project/encryption/car'
import {
  ENCRYPTED_FILE_NAME,
  encryptPlan,
  wrapOverhead,
} from '@filecoin-project/encryption/envelope'

// listEntries gives paths relative to the folder: `a.jpg`, `raw/b.jpg`.
const { files, directories } = await listEntries(root, { includeHidden })
const input = {
  type: 'directory',
  name: basename(resolve(inputPath)),
  entries: [
    ...directories.map((path) => ({ type: 'directory', path })),
    ...files.map((f) => ({ type: 'file', path: f.path, size: f.size })),
  ],
}
// A single file is { type: 'file', name, size }, and the source reads it as ''.
const source = {
  stream: (path, { signal }) =>
    createReadStream(join(inputPath, path), { signal }),
  read: async (path, offset, length) => {
    const file = await open(join(inputPath, path))
    try {
      const buffer = new Uint8Array(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await file.close()
    }
  },
}

const plan = await planInnerCar(input, source, {
  maxBytes,
  // The envelope header carries the group, so the budget counts it.
  overhead: (carBytes) => wrapOverhead(carBytes, group),
})
const { envelope, dataSetMetadata } = await encryptPlan(plan, source, {
  credentials: {
    session: {
      sessionKey,
      walletAddress,
      chainId,
      groupKeyId,
      grants: [config.grant.text],
    },
  },
  dataSets, // the owner's live data sets, as { dataSetId, metadata }
  group, // --group, or else the group of the saved Grant, from openGrant
})
await envelope.pipeTo(
  Writable.toWeb(
    createWriteStream(join(stagingDir, ENCRYPTED_FILE_NAME), { mode: 0o600 })
  )
)
// Checkpoint, then pack the outer CAR from the staged file with dfs-car.ts and upload it.
// Both copies carry dataSetMetadata. ipfsRootCID is the outer root. The piece name is encrypted.fee,
// or --name when the user passes one, never the file or folder name.
```

`plan.root` is the plaintext root CID, so the CLI keeps it out of logs, errors, and piece metadata.

### `get`

`downloadDag` checks the outer DAG against the encrypted root CID and hands the bytes of `encrypted.fee` on as a stream. `get` reads the first leaf to decide whether the file is an envelope, as filecoin-pin does: a FEE header with the CAR content type. An envelope whose labels this version can't read then fails to decrypt with a code that says why, such as `format-1`. Then it decrypts and unpacks in one pass into `<output>.filecoin-partial`, and renames the output into place only after `decryptToSink` resolves:

```ts
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { credentialKeyResolver, decryptToSink, isEnvelope } from '@filecoin-project/encryption/envelope'

if (!(await isEnvelope(firstLeaf))) return writePlainFile()

// The CLI's own convention, as in dag.ts: clear a stale partial first, and remove it on any failure.
const partial = `${output}.filecoin-partial`
await rm(partial, { recursive: true, force: true })
const sink = {
  async begin(tree) {
    // Every name in the tree has passed isUnsafeName. tree.bytes is the space it needs.
    await mkdir(partial, { mode: 0o700 })
    // tree.dirs lists parents first. Without recursive, mkdir fails with EEXIST when two names alias, such as A and a on macOS or Windows.
    for (const dir of tree.dirs) await mkdir(join(partial, dir), { mode: 0o700 })
    // Create each file and close it: a folder can hold more files than the process may keep open.
    for (const file of tree.files) await (await open(join(partial, file.path), 'wx', 0o600)).close()
  },
  async write(path, offset, bytes) {
    // One leaf is at most 1 MiB, so opening the file for each write costs little.
    const handle = await open(join(partial, path), 'r+')
    try {
      // FileHandle.write can write less than asked: loop until every byte is down.
      for (let done = 0; done < bytes.length; ) {
        const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, offset + done)
        if (bytesWritten === 0) throw new Error('The write made no progress')
        done += bytesWritten
      }
    } finally {
      // Closed before the rename or the removal: Windows can't move or delete an open file.
      await handle.close()
    }
  },
}
try {
  // On failure this throws a DecryptError: its message is safe to print, its code picks the next step.
  const result = await decryptToSink(envelopeBytes, credentialKeyResolver(credentials), sink, {
    windows: process.platform === 'win32',
    maxOutputBytes: freeBytes, // from statfs on the output's directory; 64 GiB by default
  })
  await rename(join(partial, result.name), output)
} finally {
  // The whole partial tree after a failure, including a failed rename; only the empty directory after success.
  await rm(partial, { recursive: true, force: true })
}
```

## Development

- `pnpm test` runs the tests in Node.js, then in Chromium.
- `pnpm test:node` runs `node --test` over `test/**/*.test.ts`.
- `pnpm test:browser` runs the same files in Chromium with [playwright-test](https://github.com/hugomrdias/playwright-test), which downloads the browser on its first run. Add `--browser firefox` or `--browser webkit` for the others. Two tests are skipped in browsers: a page has no heap counter, and no `SharedArrayBuffer` unless it is cross-origin isolated.
- `pnpm typecheck` checks `src` and the tests with Node's types.
- `pnpm build` compiles `src` to `dist` with `tsconfig.build.json`, for publishing. It compiles without Node's types, so it fails if `src` uses a Node API. CI runs it before `pnpm check`. Inside this repository, `exports` points to the TypeScript source.
- `pnpm lint` runs Biome.

The tests decrypt filecoin-pin's golden envelopes and rebuild their inner CARs byte for byte, open its golden Grant, and open its pinned share links. [`test/fixtures/filecoin-pin/NOTICE.md`](test/fixtures/filecoin-pin/NOTICE.md) records where the fixtures come from and their license. The tests read the fixtures through `fixture` in `test/helpers.ts`: from disk under `node --test`, and from playwright-test's server in a browser.

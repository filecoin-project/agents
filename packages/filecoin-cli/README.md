# filecoin-cli

`filecoin` is a prototype command-line interface for Filecoin. It stores a file or a folder as one copy on one Curio provider and returns retrieval URLs on [filecoin-api](../../apps/filecoin-api/README.md#retrieval). It runs on the calibration network unless you choose mainnet.

`filecoin` calls [synapse-core](https://github.com/FilOzone/synapse-sdk/tree/master/packages/synapse-core) directly. It uses [clipact](https://github.com/hugomrdias/agents/blob/main/packages/clipact/README.md) for the agent output contract and [iso-conf](https://github.com/hugomrdias/iso-repo/tree/main/packages/iso-conf) for configuration. The design follows the [CLI interface research](../../docs/filecoin/interface-research.md) and the [CLI guidelines for agents](https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/guidelines.md). The [architecture](../../docs/filecoin/architecture.md) describes the modules and flows.

Releases publish to npm as [`filecoin`](https://www.npmjs.com/package/filecoin). It needs Node.js 24 or newer. Install it, or run it without installing with `npx -y filecoin`:

```sh
npm install --global filecoin
filecoin --help
```

To build `filecoin` from source and put it on your path, run these commands from the repository root:

```sh
pnpm turbo run build --filter=filecoin
alias filecoin="node $PWD/packages/filecoin-cli/bin/filecoin.js"
filecoin --help
```

## Log in

```sh
filecoin login
```

`filecoin login` generates a session key and saves it locally. It then opens the [filecoin-app](https://fil-app.hugomrdias.dev) setup page with the key's address. The wallet owner reviews the request there and approves it with their wallet. The private key never leaves the machine, and the CLI finds the approval on chain, so there is nothing to copy back.

By default, `filecoin login` requests the `createDataSet`, `addPieces`, and `schedulePieceRemovals` scopes for 30 days, under the name `filecoin-cli`. To request other scopes, repeat `--scopes`. `--name` sets the name the owner sees, which is recorded on chain, and `--days` sets the expiry. The owner can change all three on the page before approving.

The session key signs each request, the provider submits the transactions, and the wallet pays for storage.

In a terminal, `filecoin login` opens the browser and waits for approval. An agent, or any run without a terminal, gets a `login_pending` error instead and never waits. The error's `next` steps are the approval link for the user and `filecoin login --check` for the agent to run after the user approves. `--check` only confirms the saved key and never generates a new one.

Running `filecoin login` again never changes a saved key's request: flags you leave out keep the saved key's scopes, name, and expiry. An interrupted login resumes with the same key, and an approved key is reused when it holds the requested scopes. `filecoin login` replaces a saved key on its own only when the key has expired. If `--scopes` asks for more than a pending or valid key holds, `filecoin login` returns `session_conflict` and keeps the key, because the owner may already have approved it. To replace the key, pass `--fresh`.

For CI, set `FILECOIN_SESSION_KEY` and `FILECOIN_ROOT_ADDRESS` instead of running `filecoin login`. `filecoin` reads the session key only from the environment and never prints it.

## Check the account

The session key cannot fund the account. `filecoin status` reports the expiry of each scope, the USDFC funds, and the Warm Storage (FWSS) approval. When the account needs a deposit, `filecoin status` also returns a prefilled funding link to the filecoin-app setup page.

`filecoin doctor` shows the network, RPC, filecoin-app origin (`console`), filecoin-api origin (`api`), and state directory that `filecoin` resolved, with the source of each value. It also checks the database and the RPC.

## Store and retrieve

```sh
filecoin put ./report.pdf          # raw piece   → <api>/get/<pieceCid>
filecoin put ./site                # UnixFS CAR  → <api>/get/<rootCid>?browser=true
filecoin put ./site --dry-run      # size, provider, cost, and authorization; stores nothing
filecoin publish ./site            # alias of put
filecoin get res_… --output ./copy # verifies the PieceCID and extracts folders
filecoin ls                        # add --all to include resources pending removal
filecoin inspect res_… --check     # sends a HEAD request to the piece URL
filecoin delete res_… --yes        # alias rm; schedules removal
```

`filecoin` stores a file as its exact bytes. It packs a folder into a UnixFS CAR with the IPIP-499 `unixfs-v1-2025` profile, the same way as [Filecoin Pin](https://github.com/filecoin-project/filecoin-pin). The CAR goes into a data set with `withIPFSIndexing`, so Curio serves it at `/ipfs/<rootCid>/`. Curio's `/ipfs` endpoint is a trustless gateway. It returns blocks and CARs, not rendered pages.

`put` returns two links on filecoin-api's `/get/{cid}` route, which redirects without proxying the bytes:

- `urls.piece` redirects to the exact stored bytes at a provider's `/piece/<pieceCid>`.
- `urls.browser` is the link to share. A browser renders a file from the same `/piece` URL. A folder goes through [inbrowser.link](https://inbrowser.link), which verifies the blocks in the browser.

`put` also prints an early browser link to stderr as `filecoin: link: <url>`, so an agent can show it to the user while the commit confirms:

- **A file's link** comes once the provider has parked the piece. It carries a `provider=<id>` hint, and filecoin-api redirects to that provider until its indexer has the piece. Curio serves a parked piece before the commit, so the link works at once.
- **A folder's link** comes once the commit is sent. It goes to inbrowser.link, which finds the blocks through IPNI. Curio indexes the CAR and announces it to IPNI when it receives the commit, so the link starts working shortly after.

The links in the result carry no hint. filecoin-api finds providers through its indexer, so they return 404 until the indexer has the piece. `filecoin get` downloads from the provider directly.

Packing skips dotfiles and rejects symlinks. The file or the packed CAR must be between 127 and 1,065,353,216 bytes (1016 MiB).

`delete` schedules removal, and the provider then deletes the stored copy. The resource state becomes `removal_pending`. Without `--yes`, `delete` asks a human at a terminal to confirm. In every other case, including for agents, it returns `confirmation_required` with a step for the user (`by: "user"`).

## Resume an interrupted put or delete

```sh
filecoin operations ls --incomplete
filecoin operations inspect op_…
filecoin operations resume op_…
```

Each `put` and `delete` saves an operation in the local SQLite database before it changes anything on chain or at the provider. It prints the operation ID to stderr at once, so the ID survives even a SIGKILL. It then saves a checkpoint after each step.

An error from a put or delete carries a `filecoin operations resume <id>` step and is never `retryable`. Running the original command again would start a new paid operation. Errors with a `filecoin` code also carry the ID in `error.details.operationId`. clipact's built-in codes, such as `invalid_input`, keep their own `details`.

A resumed put never commits twice. `filecoin` signs the commit with a fresh nonce and saves it before sending it. A resume first asks FWSS (`clientNonces`) whether that nonce landed. If it did not, the resume sends the same signature again, and FWSS accepts it at most once.

A resume also does the following:

- Skips the upload when the provider already has the piece.
- Fails with `source_changed` when the source file changed.
- Returns the saved result of an operation that already completed.

If a removal transaction reverts, the resource stays active and you can resume the delete.

Ctrl+C, SIGTERM, or SIGHUP stops the work at the next step. `filecoin` returns an `interrupted` result with the resume step, then re-raises the signal, so the shell sees `130`, `143`, or `129`.

## Output and errors

`filecoin` follows the [clipact](https://github.com/hugomrdias/agents/blob/main/packages/clipact/README.md) output contract. It uses machine mode when you pass `--json`, set `FILECOIN_OUTPUT=json`, run it from a detected agent, or redirect stdout away from a terminal. In machine mode, it writes one JSON object to stdout, with `data` on success or `error` on failure, then optional `next` steps. The exit code is `0` when the result has `data` and `1` when it has `error`. Diagnostics and progress go to stderr in every mode.

| Command | Prints |
| --- | --- |
| `filecoin schema --list` | Every command, offline |
| `filecoin schema <command>` | The command's input and output as JSON Schema, and its error codes |
| `filecoin completion <shell>` | A completion script for `bash`, `zsh`, or `fish` |
| `filecoin skills install` | Installs the bundled [agent skill](../../plugins/filecoin/skills/filecoin/SKILL.md), which the build copies from the [filecoin plugin](../../plugins/filecoin/README.md) |

| Error code | Meaning |
| --- | --- |
| `auth_required`, `login_pending`, `session_expired`, `permission_denied` | The user must log in or approve scopes |
| `session_conflict` | `filecoin login --scopes` would replace a pending or valid key. Keep it with `filecoin login --check`, or replace it with `--fresh` |
| `insufficient_funds` | The user must fund the account at the filecoin-app link |
| `not_found` | No resource, operation, provider, or piece has that name |
| `output_exists` | The `filecoin get` output path exists. Pass `--force` to overwrite it |
| `operation_failed`, `commit_rejected`, `removal_reverted`, `source_changed`, `staging_missing`, `operation_running` | A put or delete stopped. Follow the `next` steps |
| `verification_failed` | Retrieved bytes or blocks do not match their CIDs |
| `unsafe_path` | A retrieved archive tried to write outside the output directory |
| `invalid_input`, `confirmation_required`, `interrupted`, `internal_error`, `service_unavailable`, `timeout` | Built into clipact. See [clipact errors](https://github.com/hugomrdias/agents/blob/main/packages/clipact/README.md#errors) |

## Configuration and state

| Variable | Purpose |
| --- | --- |
| `FILECOIN_NETWORK` | `mainnet` or `calibration`. `--network` takes precedence, then `FILECOIN_NETWORK`, then the config file, then `calibration` |
| `FILECOIN_SESSION_KEY`, `FILECOIN_ROOT_ADDRESS` | Session key and wallet address, used instead of `filecoin login` |
| `FILECOIN_CONFIG_DIR` | Config directory. Default: the platform config directory for `filecoin` |
| `FILECOIN_STATE_DIR` | SQLite state and staged CARs. Default: the platform data directory for `filecoin` |
| `FILECOIN_RPC_URL` | RPC endpoint. Default: synapse-core's fallback transport for the chain |
| `FILECOIN_CONSOLE_URL` | filecoin-app origin for approval and funding links, such as `http://localhost:5173` for a local app. Default: `https://fil-app.hugomrdias.dev` |
| `FILECOIN_API_URL` | filecoin-api origin for retrieval links, such as `http://localhost:8787` for a local API. Default: `https://fil-api.hugomrdias.dev` |
| `FILECOIN_OUTPUT`, `FILECOIN_AGENT` | Override clipact's output mode and agent detection |

The prototype saves the session private key in the config file with mode 0600, so only its owner can read it. `filecoin logout` deletes the local key. The key stays authorized on chain until it expires or you revoke it on the filecoin-app session keys page.

## Development

Each command has a definition in `src/commands/` and a handler in `src/handlers/`. Definitions import only zod and clipact. clipact loads a handler only when its command runs, so `--help`, `--version`, and `schema` never import synapse-core.

`pnpm build` bundles the CLI with esbuild into `dist/`, with one chunk per handler. `bin/filecoin.js` turns on Node's compile cache, then loads the bundle.

Most tests run the CLI in process with `clipact/testing`. `test/contract.test.ts` spawns the built `bin/filecoin.js` to test stdout, exit codes, and signals on a real process.

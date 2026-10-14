---
name: filecoin
description: Store files and folders on Filecoin with the filecoin CLI, return links to share them, and retrieve and verify them later. Use when the user asks to publish, store, share, back up, retrieve, or verify content on Filecoin.
---

# Filecoin for Agents

`filecoin` stores a file (its exact bytes) or a folder (a UnixFS CAR served over IPFS) on Filecoin and returns links to share it. A person owns the wallet and approves what you may do. You never hold the wallet key.

## Run it

Run `filecoin` when it is on the PATH. Otherwise run `npx -y filecoin` in its place, which needs Node.js 24 or newer.

Every command writes one JSON object to stdout: `data` on success or `error` on failure, then optional `next` steps. Branch on `error.code`, never on stderr text.

Don't guess flags or fields. The installed CLI describes itself:

- `filecoin --help` lists the commands, and `filecoin <command> --help` shows examples and flags.
- `filecoin schema <command>` gives the input and output JSON Schemas, and what each error code means.

## Workflow

1. `filecoin status` shows whether a session key is approved and the account is funded.
2. `filecoin put <path> --dry-run` reports the size, provider, cost, and missing authorization without storing anything.
3. `filecoin put <path>` stores it. Give the user `data.urls.browser` exactly as returned, with `data.resource.ref`.
4. `filecoin get <ref>` downloads the content and verifies it. `filecoin ls` and `filecoin inspect <ref>` find what was stored.

## Rules

- Never ask for or pass a private key. Logging in needs the user: `auth_required` or `login_pending` means relay the `by: "user"` step (the filecoin-app approval link) and stop. After the user approves, run `filecoin login --check` once to confirm. On `session_conflict`, keep the saved key unless the user agrees to approve a new one.
- `insufficient_funds` and `session_expired` also need the user. Relay their `next` steps.
- `filecoin delete <ref>` needs `--yes`. On `confirmation_required`, relay the reason and rerun with `--yes` only after the user agrees.
- Never repeat a failed or interrupted `put` or `delete`: that starts a new paid operation. Run the `filecoin operations resume <id>` command from `next` instead. Errors with a filecoin CLI code also carry the ID in `error.details.operationId`. Find lost operation IDs with `filecoin operations ls --incomplete`.
- Retry only when `error.retryable` is `true`, after `retryAfterSeconds` when present.

## Read more only when you need it

Fetch these pages; each is Markdown:

- No browser to open, or a disk that is gone when the session ends, such as a cloud sandbox: read [Cloud agents](https://fil-app.hugomrdias.dev/agents.md#cloud-agents) before `filecoin login`.
- A link returns 404, the user wants proof the content is intact, or `filecoin ls` is missing content stored elsewhere: read [Retrieve and verify](https://fil-app.hugomrdias.dev/docs/retrieve.md).

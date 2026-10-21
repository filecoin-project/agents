# filecoin-api

A Cloudflare Worker that serves a read-only REST API and an MCP server for Filecoin data: storage providers, data sets, pieces, Filecoin Pay rails and session keys. Data comes from the Ponder indexer Postgres database (schemas `early-repair` and `foc-observer`) through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/).

Built with [Hono](https://hono.dev), [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi), [`@hono/mcp`](https://github.com/honojs/middleware/tree/main/packages/mcp) and [postgres.js](https://github.com/porsager/postgres).

## Routes

| Route | Description |
| --- | --- |
| `GET /openapi.json` | OpenAPI 3.1 document |
| `GET /docs` | API reference (Scalar) |
| `POST /mcp` | MCP server (Streamable HTTP, stateless) |
| `GET /mcp/server-card` | The MCP server's [server card](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md), at the location SEP-2127 reserves next to the endpoint (see [Server card](#server-card)) |
| `GET /.well-known/mcp/server-card.json`, `GET /.well-known/mcp-server-card` | The same card, at the paths of older drafts, which scanners still check |
| `GET /health` | Latest indexed block per network and indexer; `503` if a configured database fails |
| `GET /get/{cid}` | Redirect to where a PieceCID or IPFS root CID can be retrieved (see [Retrieval](#retrieval)) |

Every data route is namespaced by network: `/calibration/...` or `/mainnet/...`.

`https://mcp.filecoin.io` and `https://mcp.filecoin.cloud` serve only the MCP server, at `POST /`, and its server card. [`src/mcp-host.ts`](src/mcp-host.ts) rewrites `/` to `/mcp` and `/server-card` to `/mcp/server-card` for the hostnames in the `MCP_HOSTS` variable, so the MCP host shares the `/mcp` handler, rate limit and CORS. It also serves the two `.well-known` card paths, and returns `404` for every other path. `/mcp` keeps working on the API hosts. See [API and MCP domains](../../docs/filecoin/mcp-domains.md).

| Route | Filters |
| --- | --- |
| `/{network}/status` | none |
| `/{network}/providers` | `approved`, `active`, `endorsed` |
| `/{network}/providers/{providerId}` | none |
| `/{network}/data-sets` | `owner`, `provider_id`, `deleted`, `with_cdn` |
| `/{network}/data-sets/{dataSetId}` | none |
| `/{network}/data-sets/{dataSetId}/pieces` | `removed` |
| `/{network}/data-sets/{dataSetId}/pieces/{pieceId}` | none |
| `/{network}/pieces` | `owner`, `cid` (a PieceCID v2; legacy v1 PieceCIDs and other strings return `400`), `provider_id`, `removed` (at least one of the first three is required) |
| `/{network}/rails` | `payer`, `payee`, `operator`, `token`, `state` (`active`, `terminated` or `finalized`) |
| `/{network}/rails/{railId}` | none |
| `/{network}/rails/{railId}/settlements` | none |
| `/{network}/session-keys` | `identity`, `signer`, `active` |
| `/{network}/session-keys/history` | `identity`, `signer` |

Conventions:
- **Owner** is the client address that pays for a data set (`data_sets.payer`).
- **Rails** are rebuilt from Filecoin Pay events. Session keys are rebuilt from SessionKeyRegistry `AuthorizationsUpdated` events, keeping the latest expiry for each permission.
- **Big numbers** (ids, amounts, epochs) are returned as decimal strings.
- **Pagination** uses `limit` (1–200, default 50) and an opaque `cursor`. Each response looks like `{ data, nextCursor }`.
- **Errors** look like `{ error: { code, message } }`.

### Server card

The card describes the MCP server before a client connects: its name, title, version, and Streamable HTTP endpoint. [`src/server-card.ts`](src/server-card.ts) builds it, and `serverInfo` reads the same name and title from there, so a client sees the same identity before and after it connects:

| Field | Value |
| --- | --- |
| `name` | `io.filecoin/mcp`, which is `mcp.filecoin.io` in reverse-DNS form. The MCP registry entry uses the same name ([#75](https://github.com/filecoin-project/agents/issues/75)) |
| `title` | `Filecoin` |
| `version` | The filecoin-api version |
| `remotes[0].url` | `MCP_PUBLIC_URL`, which is `https://mcp.filecoin.io` in production, on every host. Previews and `pnpm dev` set it to an empty string, so the card advertises the endpoint on the request's host: its root on an MCP host, and `/mcp` elsewhere |
| `remotes[0].supportedProtocolVersions` | The MCP SDK's protocol versions that include Streamable HTTP |

The card is sent as `application/mcp-server-card+json`, with `Cache-Control: public, max-age=3600` and an `ETag`, and shares the REST API's rate limit.

### Retrieval

`GET /get/{cid}?network=mainnet&browser=false` redirects (`302`) to where the content can be fetched. The Worker never proxies the bytes. `network` defaults to `mainnet`. The CID's codec and multihash decide where the redirect goes:

| CID | `browser` | Redirect |
| --- | --- | --- |
| PieceCID v2 (`bafkzcib…`) | `false` or absent | `{serviceUrl}/piece/{cid}` on a provider storing the piece |
| PieceCID v2 (`bafkzcib…`) | `true` | `https://inbrowser.link/ipfs/{root}` when the chosen copy has `ipfsRootCID` metadata in an IPFS-indexed data set, otherwise `{serviceUrl}/piece/{cid}` |
| Other CID (IPFS content) | `false` or absent | `{serviceUrl}/ipfs/{cid}` on a provider with a piece whose `ipfsRootCID` metadata matches, in an IPFS-indexed data set |
| Other CID (IPFS content) | `true` | `https://inbrowser.link/ipfs/{cid}`, without a database lookup |

`provider={id}` names a provider to redirect to when no indexed copy exists, using the same paths. It covers the time between a provider parking a piece and the indexer seeing the commit, because Curio serves `/piece/{cid}` for a parked piece. The provider must be active, with an HTTP service URL. An indexed copy always wins over the hint, and the hint is never cached, so the normal ranking takes over once the indexer has the piece. `filecoin put` adds the hint to the links it reports before the commit confirms. The hint does nothing for an IPFS CID with `browser=true`, which needs no lookup.

Legacy v1 PieceCIDs (`baga…`) and strings that aren't CIDs return `400`. If no live copy exists and no hint applies, the response is `404`. Other query parameters, such as `format=car`, are forwarded to the target. When several providers store the content, the route ranks endorsed providers first, then approved ones, then the oldest copy.

Resolved providers are cached per network and CID in the [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) with stale-while-revalidate:
- An entry is fresh for 10 minutes.
- After that, it is still served immediately for up to 24 hours, and refreshed in the background after the response.
- The `X-Cache` response header reports `hit`, `stale`, `miss` or `none`.
- The cache is per datacenter. It also works on `workers.dev` preview URLs; only the dashboard editor and the Playground ignore Cache API calls.

The MCP server offers one tool per data route: `get_status`, `list_providers`, `get_provider`, `list_data_sets`, `get_data_set`, `list_data_set_pieces`, `get_piece`, `list_pieces`, `list_rails`, `get_rail`, `list_rail_settlements`, `list_session_keys` and `list_session_key_events`. Each of these requires a `network` argument.

The server reports itself as `filecoin-api`, titled `Filecoin`, with the release version from [`src/app.ts`](src/app.ts), which release-please updates along with `openapi.json`. Every tool has a display `title`, such as `List storage providers`, and the `readOnlyHint`, `idempotentHint` and `openWorldHint` annotations. Clients match permission rules on the tool names, so renaming a tool breaks them; change its `title` instead.

`search_docs` searches the Filecoin docs at [docs.filecoin.io](https://docs.filecoin.io). It forwards the `query` to the `searchDocumentation` tool of GitBook's [hosted MCP server](https://gitbook.com/docs/ai-for-your-readers/mcp-servers-for-published-docs) for the site, `https://docs.filecoin.io/~gitbook/mcp`, with one stateless `tools/call`, and returns GitBook's page excerpts unchanged. [`src/mcp/docs-search.ts`](src/mcp/docs-search.ts) caches results in `caches.default`, keyed by the query trimmed, with whitespace collapsed and lowercased. A result is fresh for an hour and served stale for up to 24 hours while it is refreshed in the background. Failed searches are not cached and return a `docs_unavailable` tool error. The root span gets a `filecoin.docs_search.cache` attribute: `hit`, `stale` or `miss`.

## Development

Copy `.env.example` to `.env` (gitignored) and fill in a connection string for every Hyperdrive binding in `wrangler.jsonc`. Wrangler reads these from `.env` or the shell, not from `.dev.vars`. The `dev` script sets `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` so the connection strings are not also exposed to the Worker as secrets:

```bash
cp .env.example .env
```

Then start the dev server:

```bash
pnpm --filter filecoin-api dev
```

The `dev` script passes `--var MCP_PUBLIC_URL:`, so the server card advertises the dev server's own `/mcp` instead of production. Wrangler sets the request host to the first route in `wrangler.jsonc`, so the card's URL, like the OpenAPI document's server URL, shows `http://api.filecoin.cloud` instead of `localhost`.

Scripts:
- `pnpm test`: vitest in workerd via `@cloudflare/vitest-plugin`, with a fake database. It fails when `openapi.json` differs from the document the Worker serves.
- `pnpm gen:openapi`: rewrites `openapi.json` from the routes. Run it after changing a route or schema, then `pnpm --filter @filecoin-project/api-client gen` to update the [client](../../packages/filecoin-api-client/README.md) types.
- `pnpm typecheck`: checks that the generated worker types are current and runs `tsc`
- `pnpm cf-typegen`: regenerates `worker-configuration.d.ts` after changing `wrangler.jsonc`

## Deploy

[`.github/workflows/filecoin-api.yml`](../../.github/workflows/filecoin-api.yml) deploys automatically:

| Trigger | Result |
| --- | --- |
| Push to `main` | Runs typecheck, tests and lint, then `wrangler deploy` to https://api.filecoin.io and https://mcp.filecoin.io, and to their `filecoin.cloud` twins. Probes `/health` on https://api.filecoin.io, and sends an MCP `initialize` to https://mcp.filecoin.io |
| Pull request opened or updated | `wrangler preview --name pr-<number>` creates a [Worker Preview](https://developers.cloudflare.com/workers/previews/) on `workers.dev`, probes `/health` and comments its URL on the PR |
| Pull request closed | `wrangler preview delete` removes the preview |

The production deploy uses the `fil-api-production` GitHub environment, so its deployment history, URL and any protection rules stay separate from filecoin-app's. The workflow only runs when `apps/filecoin-api`, the lockfile, `pnpm-workspace.yaml`, `turbo.json` or the workflow itself changes. Pull requests from forks get no preview, because they can't read the secrets.

Previews don't inherit production bindings, so the `previews` block in `wrangler.jsonc` repeats both Hyperdrive bindings. Previews read the same read-only databases as production but use separate rate-limit namespaces.

### Setup

Both Workers deploy to the FilOz Cloudflare account, which `account_id` in `wrangler.jsonc` pins, so Wrangler never asks which account to use and CI needs no account secret.

1. Create a Cloudflare API token from the **Edit Cloudflare Workers** template. Scope it to the FilOz account and the `filecoin.cloud` zone.
2. Add it as a repository secret:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN
   ```
3. Create a Hyperdrive config for each network and put the ids in `wrangler.jsonc`, in both the top-level `hyperdrive` list and `previews.hyperdrive`:
   ```bash
   wrangler hyperdrive create fil-api-calibration --connection-string="postgresql://user:password@host:5432/indexers" --max-age 5 --swr 0 --origin-connection-limit 60
   ```
   Hyperdrive caches read queries for 60 seconds by default and never invalidates them, which would make the indexer status, and every read after a write, up to 75 seconds stale. Both configs cache for 5 seconds with no stale-while-revalidate. To change an existing config, run `wrangler hyperdrive update <id> --caching-disabled=false --max-age 5 --swr 0`.
4. Connect `api.filecoin.io` and `mcp.filecoin.io`, whose DNS is on DNSimple, as Cloudflare for SaaS custom hostnames on the `filecoin.cloud` zone. These are one-time dashboard steps, described in [API and MCP domains](../../docs/filecoin/mcp-domains.md#a-domain-on-another-dns-provider). The deploy token can create the Worker routes but not the custom hostnames.

To deploy manually, run `pnpm --filter filecoin-api deploy`.

Each network needs its own Hyperdrive binding. Run `pnpm cf-typegen` after changing bindings. A network without a binding returns `503 network_unavailable`.

### Placement

The Worker runs in Frankfurt, set by `placement.region: "gcp:europe-west3"` in `wrangler.jsonc`. The `cf-placement` response header shows where a request ran, such as `remote-FRA`.

Previews run without placement. Cloudflare documents that Previews inherit top-level placement, and `wrangler preview` sends it, but on 2026-10-07 the API stored the Preview deployment with `"placement": {}`, and responses carried no `cf-placement` header. Preview timings therefore do not show production's placement.

Both indexer databases run on Hetzner in Helsinki, and Hyperdrive keeps their connection pool in Frankfurt. Each query travels from the Worker to the pool and from there to Helsinki. The query itself takes about 0.05 ms on Postgres, so network distance makes up nearly all of the database time. A request's first query costs about two round trips to the pool, so a Worker far from Frankfurt pays that distance twice, even though every route runs one query.

We measured this on 2026-10-07 with test Workers sharing production's Hyperdrive configs. An uncached query took this long from each Worker location:

| Worker location | Time per query |
| --- | --- |
| Frankfurt | ~30 ms |
| Amsterdam | ~37 ms |
| London | ~45 ms |
| Helsinki, next to the databases | ~60 ms |
| Lisbon, with no placement | ~70 ms |
| US East | ~127 ms |

From [Globalping](https://globalping.io) probes in ten cities, with uncached reads and no placement, database time grew with distance from Frankfurt, up to 610 ms from Sydney. Pinned to Frankfurt, it stayed between 40 and 65 ms from every city, and median time to first byte about halved outside Europe. Clients close to Frankfurt gain little: from Lisbon, the median rose from 106 to 122 ms.

We rejected the other placement options:

- **Helsinki** (`gcp:europe-north1`) is slower than Frankfurt, because queries go to the Frankfurt pool and back.
- **Smart Placement** (`mode: "smart"`) still ran the Worker at the nearest location 30 minutes after deploy. It needs steady traffic from many locations, and it only picks locations where the Worker already runs.
- **Host probes** (`placement.host` set to the database) also picked Frankfurt, but Cloudflare marks them experimental and they took minutes to settle.

Keep `prepare: true` in `src/db.ts`. With `prepare: false`, each query costs a second round trip: about 130 ms instead of 70 ms from Lisbon.

If the databases move, measure again. A database a few milliseconds from Frankfurt, such as one on Hetzner in Falkenstein or Nuremberg, should cut queries to about 5–10 ms, but we have not measured it.

## Observability and limits

- **Workers Logs and traces** are enabled in `wrangler.jsonc`. Cloudflare writes one invocation log per request (method, URL, status, CPU and wall time). The app adds no per-request log line; it only logs unexpected errors.
- **Trace spans:** the root span gets `http.route`, `filecoin.network` and `filecoin.db.queries` attributes, and every database query runs in a `db.query` child span with its SQL text and returned row count. Workers tracing only records a `hyperdrive_connect` span for opening the connection, so these spans are the only place query time shows up. Unexpected errors are recorded on the root span.
- **Request ids:** `X-Request-Id` is the Cloudflare Ray ID, the same value as `$metadata.rayId` on every log and span, so one id from a client finds the whole request. Client-sent `X-Request-Id` headers are ignored.
- **Response headers:** `X-Request-Id`, `Server-Timing` with `db` and `total` metrics, and `RateLimit-Policy` on rate-limited routes.
- **Unknown paths:** only `/calibration/...` and `/mainnet/...` reach the network middleware and API rate limiter. Other paths, such as crawler requests for `/sitemap.xml`, get a plain `404 not_found`. A valid route under an unsupported network, such as `/filecoin/providers`, gets `404 unknown_network`.
- **Rate limits:** [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) per client IP, at 120 requests/min for the REST API, `/health`, and the server card, and 60 requests/min for MCP. Every rate-limited response, including `429`, sends the limit in a `RateLimit-Policy` header in the [IETF RateLimit header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) format: `"api";q=120;w=60` for the REST API and `/health`, and `"mcp";q=60;w=60` for MCP. Workers Rate Limiting does not report remaining requests, so there is no `RateLimit` header. Over the limit, requests get a `429` with `Retry-After`. The policy values in [`src/middleware/rate-limit.ts`](src/middleware/rate-limit.ts) must match the `simple` limits in `wrangler.jsonc`.
- **Caching:** data responses carry no `max-age`, so browsers and proxies never serve a stored copy and every request reaches the Worker; `/health` sends `no-store`. Indexed data changes every 30-second epoch, and a cached response would show a write as missing after the indexer had it. Data reads are only cached by Hyperdrive's 5-second query cache (see the setup steps). Responses that do not depend on fresh indexer data keep a `max-age`: `/openapi.json` (`300`) only changes on deploy, the server card (`3600`, with an `ETag`) only changes with a release or `MCP_PUBLIC_URL`, a `/get/{cid}` redirect to inbrowser.link (`86400`) is built from the request alone, and a redirect to a provider (`60`) is already served from the provider cache. MCP `search_docs` results are cached for an hour, because the docs do not depend on the chain.

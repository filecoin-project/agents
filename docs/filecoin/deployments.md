# Deployments and domains

This document describes where Filecoin for Agents runs and which hostnames serve it. [How the deployments relate](#how-the-deployments-relate) gives the overview, and the sections after it cover filecoin-api's hostnames in detail.

## How the deployments relate

`filecoin.io` is the primary domain. The plugin, the CLI, and the site advertise its hostnames. Both apps are Cloudflare Workers in the FilOz Cloudflare account, and both run on the account's `filecoin.cloud` zone.

| App | Worker | Hostnames | Purpose |
| --- | --- | --- | --- |
| [filecoin-api](../../apps/filecoin-api/README.md) | `fil-api` | `api.filecoin.io`, `mcp.filecoin.io`, `api.filecoin.cloud`, and `mcp.filecoin.cloud` | The REST API and the MCP server |
| [filecoin-app](../../apps/filecoin-app/README.md) | `fil-app` | `poc.filecoin.cloud` | A prototype site for agent discovery, with the explorer and the wallet dashboard |

- **Only two `filecoin.io` hostnames point to Cloudflare.** `filecoin.io`'s DNS is on DNSimple. `www.filecoin.io` is the Filecoin website, a Next.js site on Vercel that this repository doesn't deploy. `api.filecoin.io` and `mcp.filecoin.io` are CNAMEs to `fallback.filecoin.cloud`. Cloudflare for SaaS connects each one to the `filecoin.cloud` zone, and a Worker route sends it to filecoin-api ([Subdomains of filecoin.io](#subdomains-of-filecoinio)).
- **`api.filecoin.io` and `mcp.filecoin.io` both serve the MCP server.** `api.filecoin.io` serves the REST API, and the MCP server at `/mcp`. `mcp.filecoin.io` reaches the same Worker, which serves the MCP server at `/` ([MCP hosts](../../apps/filecoin-api/README.md#mcp-hosts)). `api.filecoin.cloud` and `mcp.filecoin.cloud` are Custom Domains on the same Worker. Releases from before the move to `filecoin.io` still call them, and filecoin-app's server renders need `api.filecoin.cloud` ([Same-zone fetches](#same-zone-fetches)).
- **`poc.filecoin.cloud` is a test site for agent discovery.** filecoin-app runs there, on a Custom Domain. We try agent discovery formats on it first, such as `llms.txt`, Markdown pages, well-known paths, and WebMCP. Then we port what works to the main site, `www.filecoin.io`. [Agent discovery](agent-discovery.md) maps each spec to the host that should serve it, and [Agent discovery on filecoin.io](filecoin-io-agent-support.md) lists what filecoin.io should fix and add.

## API and MCP hostnames

Four hostnames serve filecoin-api and its MCP server:

| Hostname | Serves | How it reaches the Worker |
| --- | --- | --- |
| `api.filecoin.io` | The REST API, `/mcp`, and the server card at `/mcp/server-card` | Cloudflare for SaaS custom hostname on the `filecoin.cloud` zone, plus a Worker route |
| `mcp.filecoin.io` | The MCP server only, at `/`, and its server card at `/server-card` | Cloudflare for SaaS custom hostname on the `filecoin.cloud` zone, plus a Worker route |
| `api.filecoin.cloud` | The REST API, `/mcp`, and the server card at `/mcp/server-card` | Custom Domain |
| `mcp.filecoin.cloud` | The MCP server only, at `/`, and its server card at `/server-card` | Custom Domain |

We checked the Cloudflare behavior below against the Cloudflare docs on 2026-10-14.

## Subdomains of filecoin.cloud

`filecoin.cloud` is a zone in the FilOz Cloudflare account, which `account_id` in `wrangler.jsonc` sets. Its hostnames are therefore [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on the Worker:

```jsonc
{ "pattern": "api.filecoin.cloud", "custom_domain": true },
{ "pattern": "mcp.filecoin.cloud", "custom_domain": true },
```

`wrangler deploy` creates the DNS records and the certificates. Cloudflare can't create a Custom Domain on a hostname that already has a CNAME record.

## Subdomains of filecoin.io

`filecoin.io`'s DNS is on DNSimple. A Custom Domain needs the hostname to be in a zone on the Cloudflare account, so it can't serve `api.filecoin.io` or `mcp.filecoin.io`. A plain CNAME to `api.filecoin.cloud` doesn't work either, because Cloudflare rejects requests for a hostname it doesn't know.

[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) connects both hostnames to the `filecoin.cloud` zone as custom hostnames, on the zone's Free plan ([Plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)). The setup has four parts:

| Where | What |
| --- | --- |
| DNSimple | `api.filecoin.io` and `mcp.filecoin.io` are CNAMEs to `fallback.filecoin.cloud` |
| `filecoin.cloud` zone, **SSL/TLS > Custom Hostnames** | `api.filecoin.io` and `mcp.filecoin.io` are custom hostnames. Cloudflare issues and renews their certificates through [HTTP validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/) |
| `filecoin.cloud` zone, DNS | A proxied `fallback.filecoin.cloud AAAA 100::` record is the fallback origin. The Worker is the real origin, so the record only has to exist ([Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)) |
| filecoin-api's `wrangler.jsonc` | Worker routes on the `filecoin.cloud` zone send both hostnames to the Worker. They are routes, not Custom Domains |

The `filecoin.cloud` zone also serves other FilOz sites, such as `docs.filecoin.cloud` and `pay.filecoin.cloud`. All custom hostnames on the zone share one fallback origin, so change the fallback origin only with whoever manages the zone.

## Same-zone fetches

Server-side code on the `filecoin.cloud` zone calls filecoin-api at `api.filecoin.cloud`. A Worker's `fetch()` to a hostname on its own zone skips the zone's Worker routes, so a fetch to `api.filecoin.io` never reaches filecoin-api. A fetch to a Custom Domain does ([Worker to Worker communication](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication)). filecoin-app's API client therefore calls `api.filecoin.cloud`, and its links and discovery files advertise `api.filecoin.io`.

## Where the URLs appear

These files advertise `https://api.filecoin.io` or `https://mcp.filecoin.io`:

- The plugin's [`mcp.json`](../../plugins/filecoin/mcp.json) and [`.claude-plugin/plugin.json`](../../plugins/filecoin/.claude-plugin/plugin.json), and the custom connector URL in its [README](../../plugins/filecoin/README.md)
- `MCP_PUBLIC_URL` in filecoin-api's [`wrangler.jsonc`](../../apps/filecoin-api/wrangler.jsonc), which the server card advertises
- The CLI's `DEFAULT_API_URL` in [`src/globals.ts`](../../packages/filecoin-cli/src/globals.ts), which builds the retrieval links it prints unless `FILECOIN_API_URL` overrides it
- The REST API and MCP server rows in the [Filecoin for Agents README](README.md)
- filecoin-app's defaults in [`src/config/env.ts`](../../apps/filecoin-app/src/config/env.ts), which its retrieval links, explorer, discovery files, and `llms.txt` use ([development](../../apps/filecoin-app/README.md#development))
- filecoin-app's [landing page](../../apps/filecoin-app/src/routes/index.tsx), its header and footer links to the API reference, and its content pages
- The production probes in [`.github/workflows/filecoin-api.yml`](../../.github/workflows/filecoin-api.yml)

# API and MCP domains

This document describes the hostnames that serve filecoin-api and its MCP server. `api.filecoin.io` and `mcp.filecoin.io` are the primary hostnames, and the plugin, the CLI, and the site advertise them. `api.filecoin.cloud` and `mcp.filecoin.cloud` serve the same Worker, so links and plugins released before the switch keep working. filecoin-app's API client also needs `api.filecoin.cloud` ([same-zone fetches](#same-zone-fetches)).

| Hostname | Serves | How it reaches the Worker |
| --- | --- | --- |
| `api.filecoin.io` | The REST API, `/mcp`, and the server card at `/mcp/server-card` | Cloudflare for SaaS custom hostname on the `filecoin.cloud` zone, plus a Worker route |
| `mcp.filecoin.io` | The MCP server only, at `/`, and its server card at `/server-card` | Cloudflare for SaaS custom hostname on the `filecoin.cloud` zone, plus a Worker route |
| `api.filecoin.cloud` | The REST API, `/mcp`, and the server card at `/mcp/server-card` | Custom Domain |
| `mcp.filecoin.cloud` | The MCP server only, at `/`, and its server card at `/server-card` | Custom Domain |

We checked the Cloudflare behavior below against the Cloudflare docs on 2026-10-14.

## What the MCP hosts serve

The same `filecoin-api` Worker serves the MCP hosts. A host check in [`src/mcp-host.ts`](../../apps/filecoin-api/src/mcp-host.ts), which wraps the app in `src/index.ts`, rewrites the request before the Hono app sees it, so the MCP hosts reuse the `/mcp` handler, its rate limit, CORS, request ids, and tracing. The MCP hosts serve only MCP and the MCP server card:

| Request on an MCP host | Result |
| --- | --- |
| `POST /` | The MCP endpoint, the same as `POST https://api.filecoin.io/mcp` |
| `GET /`, `DELETE /` | `405`, as on `/mcp`, because the server is stateless |
| `OPTIONS /` | The CORS preflight |
| `GET /server-card` | The [server card](../../apps/filecoin-api/README.md#server-card), the same as `GET https://api.filecoin.io/mcp/server-card` |
| `GET /.well-known/mcp/server-card.json`, `GET /.well-known/mcp-server-card` | The same card, at the paths of older drafts |
| Any other path, such as `/mcp`, `/mcp/server-card`, `/health`, `/docs`, or `/calibration/providers` | `404 not_found` |

`/mcp` keeps working on both API hosts, because plugins released before the MCP hosts, and connectors added by hand, point to `https://api.filecoin.cloud/mcp`.

The MCP hostnames are in the `MCP_HOSTS` variable in `wrangler.jsonc`, comma separated, so adding a hostname changes no code.

Every card advertises `https://mcp.filecoin.io`, the `MCP_PUBLIC_URL` variable in `wrangler.jsonc`, whichever host serves it, so clients and the MCP registry see one endpoint.

Worker Previews run on `workers.dev`, which matches no MCP host, and set `MCP_HOSTS` to an empty string, so they keep serving MCP at `/mcp`. They also set `MCP_PUBLIC_URL` to an empty string, so their card advertises the Preview's own `/mcp`.

## Subdomains of filecoin.cloud

`filecoin.cloud` is a zone in the FilOz Cloudflare account, which `wrangler.jsonc` pins, so its hostnames are [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on the Worker:

```jsonc
{ "pattern": "api.filecoin.cloud", "custom_domain": true },
{ "pattern": "mcp.filecoin.cloud", "custom_domain": true },
```

`wrangler deploy` creates the DNS records and the certificates. Cloudflare can't create a Custom Domain on a hostname that already has a CNAME record. The deploy token covers the `filecoin.cloud` zone ([setup](../../apps/filecoin-api/README.md#setup)).

## A domain on another DNS provider

`filecoin.io`'s DNS is on DNSimple. A Custom Domain needs the hostname to be in a zone on the Cloudflare account, so it can't serve `api.filecoin.io` or `mcp.filecoin.io`. A CNAME alone doesn't work either: if `api.filecoin.io` points to `api.filecoin.cloud`, Cloudflare receives requests for a hostname it doesn't know and rejects them.

[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) connects each hostname to the `filecoin.cloud` zone as a custom hostname, and the domain's DNS stays on DNSimple. It is available on the Free plan, which the zone uses; [Plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) lists the hostname limits and prices.

On Cloudflare, in the `filecoin.cloud` zone, once:

`filecoin.cloud` also serves other FilOz sites, such as `docs.filecoin.cloud` and `pay.filecoin.cloud`, and a zone has one fallback origin for all its custom hostnames. Agree on steps 1 and 2 with whoever manages the zone.

1. Enable Cloudflare for SaaS on **SSL/TLS > Custom Hostnames**.
2. Create a proxied `fallback.filecoin.cloud AAAA 100::` record and set it as the fallback origin. The Worker is the real origin, so the record only has to exist ([Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).
3. Add `api.filecoin.io` and `mcp.filecoin.io` as custom hostnames, with HTTP certificate validation.

On DNSimple, the owner of `filecoin.io` adds:

| Record | Value |
| --- | --- |
| `api.filecoin.io CNAME` | `fallback.filecoin.cloud` |
| `mcp.filecoin.io CNAME` | `fallback.filecoin.cloud` |

Once a CNAME resolves, Cloudflare validates the hostname, then issues and renews its certificate over HTTP ([HTTP validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/)). TXT records are optional: they only issue the certificate before the CNAME goes live, which matters when a hostname already serves traffic. `filecoin.io` has no CAA records, so any certificate authority can issue. The owner doesn't move the domain or give anyone access to it.

`wrangler.jsonc` routes the hostnames to the Worker. They are routes on the `filecoin.cloud` zone, not Custom Domains:

```jsonc
{ "pattern": "api.filecoin.io/*", "zone_name": "filecoin.cloud" },
{ "pattern": "mcp.filecoin.io/*", "zone_name": "filecoin.cloud" }
```

`MCP_HOSTS` lists `mcp.filecoin.io`. The deploy token can create Worker routes, but adding custom hostnames would need SSL and certificate permissions, which it doesn't have, so steps 1 to 3 stay in the dashboard.

## Same-zone fetches

filecoin-app runs on the `filecoin.cloud` zone, and its explorer renders detail pages on the server. A Worker's `fetch()` to a hostname on its own zone skips that zone's Worker routes and goes to the zone's origin, but it does reach a Worker on a Custom Domain ([Worker to Worker communication](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication)). A server-side fetch to `api.filecoin.io` therefore reached the fallback origin, `fallback.filecoin.cloud`, which answered 522, and filecoin-api never saw it. The rail, data set, and provider pages returned 500 from 14 October, when `api.filecoin.io` became filecoin-app's default, until filecoin-app's API client moved to `api.filecoin.cloud`. The list pages kept working, because they fetch from the browser.

So filecoin-app's API client calls `api.filecoin.cloud`, while its links and discovery files still advertise `api.filecoin.io`. `api.filecoin.cloud` has to stay a Custom Domain until filecoin-app calls filecoin-api through a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) instead.

## Rejected options

- **Redirects.** A Cloudflare redirect rule or a DNSimple URL record could send the `filecoin.io` hosts to their `filecoin.cloud` twins. MCP clients don't reliably follow redirects on `POST`, and some reject a redirect to another origin. Retrieval links would also take an extra hop.
- **Moving the zone to Cloudflare.** Moving `filecoin.io` to Cloudflare would allow Custom Domains, but its owner would have to leave DNSimple. A partial (CNAME) zone setup keeps DNSimple, but needs a Business plan.
- **An apex domain.** The DNSimple setup works for subdomains, not for `filecoin.io` itself, because an apex can't be a CNAME. Proxying an apex needs Cloudflare's Enterprise Apex Proxying.

## Where the URLs appear

These files advertise `https://api.filecoin.io` or `https://mcp.filecoin.io`:

- The plugin's [`mcp.json`](../../plugins/filecoin/mcp.json) and [`.claude-plugin/plugin.json`](../../plugins/filecoin/.claude-plugin/plugin.json), and the custom connector URL in its [README](../../plugins/filecoin/README.md)
- `MCP_PUBLIC_URL` in filecoin-api's [`wrangler.jsonc`](../../apps/filecoin-api/wrangler.jsonc), which the server card advertises
- The CLI's default `FILECOIN_API_URL` in [`src/app.ts`](../../packages/filecoin-cli/src/app.ts), which builds the retrieval links it prints
- The REST API and MCP server rows in the [Filecoin for Agents README](README.md)
- filecoin-app's defaults in [`src/config/env.ts`](../../apps/filecoin-app/src/config/env.ts), which its retrieval links, explorer, discovery files, and `llms.txt` use ([development](../../apps/filecoin-app/README.md#development))
- filecoin-app's [landing page](../../apps/filecoin-app/src/routes/index.tsx), header and footer links to the API reference, and its content pages
- The production probes in [`.github/workflows/filecoin-api.yml`](../../.github/workflows/filecoin-api.yml)

## Open questions

- Who keeps the DNSimple records for `filecoin.io` in place?
- Should filecoin-app call filecoin-api through a service binding? That would remove its dependence on `api.filecoin.cloud`. filecoin-api rate-limits by `cf-connecting-ip`, and both a service binding and a same-zone fetch put every server render into one bucket. So the binding would also need filecoin-api to key the limit on the visitor's IP, which filecoin-app forwards.

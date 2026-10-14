# MCP domains

This document describes how filecoin-api serves its MCP server from its own hostname, `https://mcp.filecoin.cloud`, instead of `https://api.filecoin.cloud/mcp`. The product domain is `filecoin.cloud`, whose DNS Cloudflare manages, so the MCP host is a subdomain of it. The document also covers a domain whose DNS another provider manages, such as `filecoin.io` on DNSimple, in case the server needs a second hostname there. The `filecoin.cloud` subdomain is built, and the plugin and the site advertise it; the other provider case is not.

We checked the Cloudflare behavior below against the Cloudflare docs on 2026-10-14.

## What the MCP host serves

The same `filecoin-api` Worker serves the MCP host. A host check in [`src/mcp-host.ts`](../../apps/filecoin-api/src/mcp-host.ts), which wraps the app in `src/index.ts`, rewrites the request before the Hono app sees it, so the MCP host reuses the `/mcp` handler, its rate limit, CORS, request ids, and tracing. The MCP host serves only MCP:

| Request on the MCP host | Result |
| --- | --- |
| `POST /` | The MCP endpoint, the same as `POST https://api.filecoin.cloud/mcp` |
| `GET /`, `DELETE /` | `405`, as on `/mcp`, because the server is stateless |
| `OPTIONS /` | The CORS preflight |
| Any other path, such as `/mcp`, `/health`, `/docs`, or `/calibration/providers` | `404 not_found` |

`https://api.filecoin.cloud/mcp` keeps working, because plugins released before the move, and connectors added by hand, point to it.

The MCP hostnames are in the `MCP_HOSTS` variable in `wrangler.jsonc`, comma separated, so adding a hostname changes no code.

Worker Previews run on `workers.dev`, which matches no MCP host, and set `MCP_HOSTS` to an empty string, so they keep serving MCP at `/mcp`.

## A subdomain of filecoin.cloud

`filecoin.cloud` is a zone in the FilOz Cloudflare account, which `wrangler.jsonc` pins, so the MCP host is a second [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on the Worker, next to `api.filecoin.cloud`:

```jsonc
"routes": [
  { "pattern": "api.filecoin.cloud", "custom_domain": true },
  { "pattern": "mcp.filecoin.cloud", "custom_domain": true }
],
```

`wrangler deploy` creates the DNS record and the certificate. Cloudflare can't create a Custom Domain on a hostname that already has a CNAME record; `mcp.filecoin.cloud` had no record on 2026-10-14. The deploy token already covers the `filecoin.cloud` zone ([setup](../../apps/filecoin-api/README.md#setup)). The production workflow sends an MCP `initialize` to the host after each deploy.

## A domain on another DNS provider

A Custom Domain needs the hostname to be in a zone on the Cloudflare account, so it can't serve a hostname such as `mcp.filecoin.io`, whose DNS is on DNSimple. A CNAME alone doesn't work either: if `mcp.filecoin.io` points to `api.filecoin.cloud`, Cloudflare receives requests for a hostname it doesn't know and rejects them.

[Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) connects the hostname to the `filecoin.cloud` zone as a custom hostname, and the domain's DNS stays on DNSimple. It is available on the Free plan; [Plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) lists the hostname limits and prices.

On Cloudflare, in the `filecoin.cloud` zone:

`filecoin.cloud` also serves other FilOz sites, such as `docs.filecoin.cloud` and `pay.filecoin.cloud`, and a zone has one fallback origin for all its custom hostnames. Agree on steps 1 and 2 with whoever manages the zone.


1. Enable Cloudflare for SaaS.
2. Create a proxied `fallback.filecoin.cloud AAAA 100::` record and set it as the fallback origin. The Worker is the real origin, so the record only has to exist ([Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).
3. Add `mcp.filecoin.io` as a custom hostname. Cloudflare shows the records that prove ownership and validate the certificate.
4. Add a Worker route for the hostname in `wrangler.jsonc`. It is a route, not a Custom Domain:
   ```jsonc
   { "pattern": "mcp.filecoin.io/*", "zone_name": "filecoin.cloud" }
   ```
   We haven't tried this route in `wrangler deploy`. If Wrangler rejects it, add the route to the zone in the dashboard instead.
5. Add `mcp.filecoin.io` to `MCP_HOSTS`.

On DNSimple, the owner of `filecoin.io` adds:

| Record | Value |
| --- | --- |
| `mcp.filecoin.io CNAME` | `fallback.filecoin.cloud` |
| The TXT records from step 3 | Only needed to issue the certificate before the CNAME goes live |

The owner doesn't move the domain or give anyone access to it. Once the CNAME points to Cloudflare, Cloudflare renews the certificate over HTTP, so the TXT records can go.

Steps 1 to 3 are one-time dashboard steps. Automating them through the API would need a deploy token with SSL and certificate permissions, which it doesn't have today.

## Rejected options

- **Redirects.** A Cloudflare redirect rule or a DNSimple URL record could send the MCP host to `api.filecoin.cloud/mcp`. MCP clients don't reliably follow redirects on `POST`, and some reject a redirect to another origin.
- **Moving the zone to Cloudflare.** Moving `filecoin.io` to Cloudflare would allow a Custom Domain, but its owner would have to leave DNSimple. A partial (CNAME) zone setup keeps DNSimple, but needs a Business plan.
- **An apex domain.** The DNSimple plan works for a subdomain such as `mcp.filecoin.io`, not for `filecoin.io` itself, because an apex can't be a CNAME. Proxying an apex needs Cloudflare's Enterprise Apex Proxying.

## Where the URL appears

These files advertise `https://mcp.filecoin.cloud`. A second MCP hostname would change them too:

- The plugin's [`mcp.json`](../../plugins/filecoin/mcp.json) and [`.claude-plugin/plugin.json`](../../plugins/filecoin/.claude-plugin/plugin.json), and the custom connector URL in its [README](../../plugins/filecoin/README.md)
- The MCP server row in the [Filecoin for Agents README](README.md)
- filecoin-app's [discovery files](../../apps/filecoin-app/src/lib/site/discovery.ts) and `llms.txt`, which take the URL from `VITE_FILECOIN_MCP_URL` ([development](../../apps/filecoin-app/README.md#development))
- filecoin-app's [landing page](../../apps/filecoin-app/src/routes/index.tsx) and the [`index.md`](../../apps/filecoin-app/src/content/index.md), [`agents.md`](../../apps/filecoin-app/src/content/agents.md), [`quickstart.md`](../../apps/filecoin-app/src/content/quickstart.md), and [`api.md`](../../apps/filecoin-app/src/content/api.md) content pages

## Open questions

- Does the MCP server also need a hostname on `filecoin.io`? If so, who adds the DNSimple records, and who keeps them in place?

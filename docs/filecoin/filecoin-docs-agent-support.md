# Agent support on docs.filecoin.io

This report is for the Filecoin docs team. It covers what [docs.filecoin.io](https://docs.filecoin.io) gives AI agents through GitBook, what it lacks compared with [filecoin-app](../../apps/filecoin-app/README.md#website), and what GitBook lets the team change. We checked the live site with `curl` on 2026-10-21. We had no access to the site's GitBook settings. [How to reproduce](#how-to-reproduce) has the commands.

## Summary

docs.filecoin.io covers what agents need most. It serves `llms.txt`, `llms-full.txt`, a Markdown version of each page, a sitemap, an MCP server with its server card and AI Catalog, and WebMCP tools. The gaps are a few `/.well-known/` files, some headers and status codes, and a `/index.md` redirect to the wrong page.

GitBook's settings turn its built-in features on and off. They can't serve custom files, set response headers, or run custom code. Most of the remaining gaps need a proxy in front of GitBook, such as a Cloudflare Worker.

Recommended next steps:

1. Find out why `/index.md` redirects to the Filecoin for Agents page instead of the home page. Look in **Site settings → Redirects** first.
2. Ask GitBook to send `Vary: Accept` on HTML responses, and to return `404` for a missing page in Markdown.
3. Open the **Agents & MCP** report in site analytics to see how much agent traffic the docs get. Decide on a proxy after that.

## Changes since 2026-10-14

- **The `?ask=` instructions are gone.** On 2026-10-14, each `.md` page ended with instructions to send `GET <page>.md?ask=<question>&goal=<goal>`, and that request returned `500`. The pages now end without those instructions, and the request returns `404` in about 0.1 seconds. Agents no longer see instructions for an endpoint that fails.
- **Markdown responses send `Vary: Accept`.** HTML responses still don't ([Issues found](#issues-found)).
- **The WebMCP tools are verified.** GitBook registers the docs MCP server's tools in the page ([What works today](#what-works-today)).
- **`/index.md` redirects to the wrong page.** On 2026-10-14 it served the home page. It now returns `307` to `/build-on-filecoin/filecoin-for-agents.md`.

## What works today

| Feature | URL or behavior |
| --- | --- |
| [llms.txt](https://llmstxt.org) index | [`/llms.txt`](https://docs.filecoin.io/llms.txt), about 39 KB. It links 191 pages by their `.md` URLs |
| Full text in one file | [`/llms-full.txt`](https://docs.filecoin.io/llms-full.txt), about 678 KB |
| Markdown for each page | Add `.md` to a page URL, for example [`/getting-started/what-is-filecoin.md`](https://docs.filecoin.io/getting-started/what-is-filecoin.md). The home page is [`/welcome.md`](https://docs.filecoin.io/welcome.md) |
| Content negotiation | `Accept: text/markdown` on a page URL returns the same Markdown as `.md`, with `Vary: Accept`. `Accept: text/html` returns HTML |
| Markdown link in HTML | Each page's `<head>` has `<link rel="alternate" type="text/markdown">` |
| A pointer at the top of each Markdown page | Each `.md` page starts with a note that links `llms.txt` and explains the `.md` convention |
| Sitemaps | [`/sitemap.xml`](https://docs.filecoin.io/sitemap.xml), `/sitemap-pages.xml`, and [`/sitemap.md`](https://docs.filecoin.io/sitemap.md) |
| `robots.txt` | Allows all crawlers, links the sitemap, and sends `Content-Signal: ai-train=yes, search=yes, ai-input=yes` |
| MCP server | `https://docs.filecoin.io/~gitbook/mcp`, over Streamable HTTP. Its tools are `searchDocumentation`, `getPage`, and `sendFeedback`. filecoin-api's `search_docs` tool forwards to `searchDocumentation` |
| MCP server card | `/~gitbook/mcp/server-card` and [`/.well-known/mcp/server-card.json`](https://docs.filecoin.io/.well-known/mcp/server-card.json), with `Access-Control-Allow-Origin: *` |
| AI Catalog | [`/.well-known/ai-catalog.json`](https://docs.filecoin.io/.well-known/ai-catalog.json), with one entry that points to the server card |
| [WebMCP](https://webmachinelearning.github.io/webmcp/) tools | If the browser has `document.modelContext`, GitBook's script connects to `/~gitbook/mcp` and registers that server's tools as WebMCP tools |
| SEO metadata | Canonical URLs and Open Graph tags |

`sendFeedback` lets agents report outdated or wrong content to the docs team. Check where those reports arrive in GitBook.

## Gaps compared with filecoin-app

filecoin-app serves the files and behaviors in the first column. Its [README](../../apps/filecoin-app/README.md#website) has the details.

| filecoin-app feature | docs.filecoin.io |
| --- | --- |
| `/.well-known/api-catalog` ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727)) | `404` |
| `/.well-known/integrations.json` ([integrations.sh](https://integrations.sh/publishing/)) | `404` |
| `/.well-known/mcp-server-card` | `404`. The card is at `/.well-known/mcp/server-card.json` and `/~gitbook/mcp/server-card` |
| `/.well-known/agent-skills/index.json` ([agent skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc)) | `404` |
| `Vary: Accept` on HTML responses | Missing |
| A `Link` HTTP header to the Markdown version | Missing. The `<link>` tag in `<head>` covers clients that parse HTML |
| `404` for a missing page in Markdown | `200`, with a "Page Not Found" body that lists suggested pages |
| `406` when a client accepts neither HTML nor Markdown | `Accept: application/json` gets HTML with `200` |
| JSON-LD | None |

The API catalog and `integrations.json` describe an API. They matter only if Filecoin wants to list an API from the docs domain, such as the Lotus JSON-RPC API.

## Issues found

- **HTML responses don't send `Vary: Accept`.** The HTML and Markdown versions share a URL. The Markdown response says it varies by `Accept`, but the HTML response doesn't. A shared cache between the client and GitBook can store the HTML response and return it to an agent that asked for Markdown. GitBook's own cache served the right version in our tests. Until GitBook fixes the header, agents should use `.md` URLs.
- **A missing page returns `200` in Markdown.** With `Accept: text/markdown`, or with a `.md` URL, a missing page returns `200` and a list of suggested pages. Agents and link checkers treat the response as a real page. The HTML version returns `404`.
- **`/index.md` redirects to the Filecoin for Agents page.** `/index.md` returns `307` to `/build-on-filecoin/filecoin-for-agents.md`, and `/index` returns `307` to the HTML page. On gitbook.com, `/docs/index.md` redirects to that site's home page. An agent that guesses `/index.md` for the home page gets the wrong page. We can't see the settings, so we don't know the cause. A site redirect would produce it, and so would GitBook's automatic redirect from a moved page.

## What GitBook settings control

**Site customization → Configuration → Page actions** has these options, per [GitBook's docs](https://gitbook.com/docs/manage-your-site/customization/extra-configuration.md):

| Setting | Effect |
| --- | --- |
| Page actions | Shows the page menu. Turning it off also turns off `/~gitbook/mcp`, which then returns `404` |
| Open in AI providers | Adds actions that open the page in ChatGPT or Claude |
| Copy/View as Markdown | Adds actions that copy or open the page's Markdown |
| Connect with MCP server | Shows the MCP URL in the menu. It doesn't turn the server on or off |

GitBook makes `.md` pages, `llms.txt`, `llms-full.txt`, content negotiation, sitemaps, `robots.txt`, and the MCP server [with no settings](https://gitbook.com/docs/getting-started/llm-ready-docs.md).

[AI Assistant](https://gitbook.com/docs/ai-for-your-readers/gitbook-ai-assistant.md) is off on docs.filecoin.io. It answers readers' questions in the docs and uses AI credits. The sidebar chat needs the Ultimate site plan. Answers in the search box need the Essential or Ultimate plan. gitbook.com's docs have the Assistant on, and two things differ there. Its MCP server has a fourth tool, `askQuestion`, and its `.md` pages end with the `?ask=` instructions, which return an answer. We expect both to appear on docs.filecoin.io if the team turns the Assistant on, but we haven't confirmed it.

GitBook has no setting to serve custom files, set response headers, or change status codes. Its [site customization docs](https://gitbook.com/docs/manage-your-site/customization.md) say that a site can't take custom CSS, HTML, or JavaScript. JSON-LD and custom WebMCP tools need one of those.

## Options to close the gaps

### Site redirects close the file gaps only

**Site settings → Redirects** can send a path to a page on the site or to an external URL, with `307` or `308` ([Site redirects](https://gitbook.com/docs/publish/site-redirects.md)). The team could redirect the `/.well-known/` paths to JSON files hosted elsewhere, such as in a GitHub repository. We haven't tested this.

Redirects have these limits:

- GitBook's docs don't say whether it accepts `/.well-known/` source paths.
- Some discovery clients don't follow redirects.
- Redirects add no headers, so they fix none of the [issues found](#issues-found) except the `/index.md` redirect.

### A Cloudflare Worker in front of GitBook closes all the gaps

GitBook documents a [Cloudflare Worker proxy](https://gitbook.com/docs/publish/custom-domain/setting-a-custom-subdirectory/configuring-a-subdirectory-with-cloudflare.md) for docs under a subdirectory. A Worker on the docs hostname could serve the `/.well-known/` files, add the `Vary` and `Link` headers, fix the status codes, and add JSON-LD with HTMLRewriter.

Two things block it:

- docs.filecoin.io is a CNAME to `2821909c24-hosting.gitbook.io`, and `filecoin.io` uses DNSimple's nameservers. A Worker on this hostname needs the hostname on Cloudflare, as a zone or through Cloudflare for SaaS ([Subdomains of filecoin.io](deployments.md#subdomains-of-filecoinio)).
- GitBook documents the proxy for a subdirectory, such as `example.com/docs`, not for a whole hostname. Confirm with GitBook that it supports a proxy on a root custom domain.

## Questions for GitBook

- Can HTML responses send `Vary: Accept`, and a `Link` header to the Markdown version?
- Can a missing page return `404` when a client requests it as Markdown?
- Can the MCP server card also be served at `/.well-known/mcp-server-card`?
- Do site redirects accept `/.well-known/` source paths?
- Does GitBook support a Cloudflare Worker proxy on a root custom domain?

## How to reproduce

```bash
D=https://docs.filecoin.io

# llms.txt, full text, sitemaps, and robots.txt
for p in llms.txt llms-full.txt sitemap.xml sitemap-pages.xml sitemap.md robots.txt; do
	curl -s -o /dev/null -w "$p %{http_code} %{size_download}\n" "$D/$p"
done
curl -s "$D/llms.txt" | grep -c "^- \["

# Markdown by suffix and by Accept header
curl -s "$D/getting-started/what-is-filecoin.md" | head
curl -s -H "Accept: text/markdown" "$D/getting-started/what-is-filecoin" | head

# Vary and Link headers on the HTML and Markdown responses
curl -sI "$D/getting-started/what-is-filecoin" | grep -iE "^(vary|link):"
curl -sI -H "Accept: text/markdown" "$D/getting-started/what-is-filecoin" | grep -iE "^(vary|link):"

# A missing page: Markdown and HTML status codes
curl -s -o /dev/null -w "%{http_code}\n" -H "Accept: text/markdown" "$D/nope"
curl -s -o /dev/null -w "%{http_code}\n" "$D/nope"

# The /index.md redirect
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "$D/index.md"

# The ?ask= endpoint
curl -s -o /dev/null -w "%{http_code}\n" "$D/getting-started/what-is-filecoin.md?ask=what%20is%20filecoin&goal=learn"

# Discovery files
for p in api-catalog integrations.json mcp/server-card.json mcp-server-card ai-catalog.json agent-skills/index.json; do
	curl -s -o /dev/null -w "$p %{http_code}\n" "$D/.well-known/$p"
done

# MCP server tools
curl -s -X POST "$D/~gitbook/mcp" \
	-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
	-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -oE '"name":"[a-zA-Z]+"'

# The WebMCP component and the MCP URL it uses
curl -s "$D/getting-started/what-is-filecoin" | grep -oE 'WebMCP|mcpURL[^,]{0,20}' | sort -u

# DNS
dig +short CNAME docs.filecoin.io
dig +short NS filecoin.io
```

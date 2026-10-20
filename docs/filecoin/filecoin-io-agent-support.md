# Agent discovery on filecoin.io

This report compares how AI agents discover and read [www.filecoin.io](https://www.filecoin.io) and [poc.filecoin.cloud](https://poc.filecoin.cloud), the [filecoin-app](../../apps/filecoin-app/README.md#website) prototype. It lists the problems to fix and the things to add on filecoin.io, for the filecoin.io web team. The gaps it found in Filecoin for Agents are tracked in issues [#56](https://github.com/filecoin-project/agents/issues/56) to [#63](https://github.com/filecoin-project/agents/issues/63).

The checks ran on 2026-10-20, with `curl` against the live sites and with [Is Agentic](https://is-agentic.com) reports from the same day. We had no access to the filecoin.io source.

## Summary

filecoin.io is a Next.js site on Vercel, and `filecoin.io` redirects to `www.filecoin.io` with a `308`. The site serves a sitemap, a `robots.txt`, JSON-LD, and Open Graph tags, and the server renders each page. It serves none of the files that tell agents where the docs, the API, the MCP server, and the agent skills are. It has no `llms.txt`, no Markdown versions of its pages, and nothing under `/.well-known/`.

Is Agentic scores filecoin.io 83 and poc.filecoin.cloud 88. The site itself earns less than 83. Is Agentic also gives filecoin.io credit for services on other hostnames:

- The OpenAPI document at `api.filecoin.io` and the MCP server at `mcp.filecoin.io`, which this project runs.
- The `llms.txt` and the MCP server of docs.filecoin.io.
- The `filecoin` CLI on npm.

No page on www.filecoin.io links agents to any of them.

Next.js can serve every file and header in this report, with route handlers, middleware, and headers in `next.config`. filecoin.io needs no proxy, unlike [docs.filecoin.io on GitBook](filecoin-docs-agent-support.md).

Do these three things on filecoin.io first:

1. Pick one hostname, and use it in the canonical URLs and the sitemap.
2. Add a `/llms.txt` that says when to use Filecoin and links the docs, the API, the MCP server, and the agent skill.
3. Serve each page as Markdown at a `.md` URL and for `Accept: text/markdown`, with `Vary: Accept`.

## Is Agentic scores

| | www.filecoin.io | poc.filecoin.cloud |
| --- | --- | --- |
| Score | 83, "Ready with a few material gaps" | 88, "Strong technical baseline" |
| Essential checks | 61.7 of 80 points | 70 of 80 points |
| Recommended checks | 15.8 of 20 points | 14.1 of 20 points |
| Bonus | +5 points | +4.1 points |
| Report | [is-agentic.com/scan/filecoin.io](https://is-agentic.com/scan/filecoin.io) | [is-agentic.com/scan/poc.filecoin.cloud](https://is-agentic.com/scan/poc.filecoin.cloud) |

The scans ran at 13:30 and 13:33 UTC. Is Agentic infers a site type and scores the checks that apply to it. It inferred App for both sites. The table shows points, because the report API and the report page count the passed checks differently. A new scan can change the score.

## The two sites side by side

| Feature | www.filecoin.io | poc.filecoin.cloud |
| --- | --- | --- |
| `/llms.txt`, `/llms-full.txt` | `404` | `200`, about 2.6 KB and 33 KB |
| Markdown at `.md` URLs | `404` | `200`, `text/markdown` |
| `Accept: text/markdown` | Returns HTML | Returns Markdown |
| `Vary: Accept` | Missing. `Vary` lists only the Next.js router headers | Present |
| `Link` header to the Markdown version | Missing. The `Link` header lists only the language versions | `</index.md>; rel="alternate"; type="text/markdown"` |
| `<link rel="alternate" type="text/markdown">` | Missing | Present |
| Missing page | HTML `404` | HTML `404`, or a Markdown `404` that links to `llms.txt` and the sitemap |
| `Accept: application/json` | HTML `200` | Markdown `406` |
| `/.well-known/api-catalog` ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727)) | `404` | `200` |
| `/.well-known/integrations.json` ([integrations.sh](https://integrations.sh/publishing/)) | `404` | `200` |
| `/.well-known/mcp/server-card.json`, `/.well-known/mcp-server-card` | `404` | `200` |
| `/.well-known/agent-skills/index.json` ([agent skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc)) | `404` | `200` |
| `/.well-known/ai-catalog.json` | `404` | `404` |
| JSON-LD | Organization, WebSite, WebPage, BreadcrumbList | SoftwareApplication |
| Canonical URL and Open Graph tags | Present | Present |
| `sitemap.xml` | 751 URLs, each with `lastmod` | 9 URLs |
| `robots.txt` | Allows all crawlers, links the sitemap | Allows all crawlers, links the sitemap |
| Home page HTML | About 896 KB for about 6 KB of text | About 26 KB for about 2 KB of text |
| About, Contact, Privacy, and Pricing pages | Present | Missing |
| [WebMCP](https://webmachinelearning.github.io/webmcp/) tools | None | Registered by the app's script bundle |

## Problems to fix on filecoin.io

- **Canonical URLs redirect.** The canonical tag and all 751 sitemap entries use `https://filecoin.io/…`. Each of those URLs returns a `308` to `www.filecoin.io`, so every crawler and agent request makes an extra request. Use `https://www.filecoin.io` in both places. Or serve the site from `filecoin.io` and redirect `www` to it.
- **Pages don't answer `Accept: text/markdown`.** The home page returns HTML for that header, and `Vary` doesn't name `Accept`. Is Agentic counts this as a failed essential check. It tests the home page, so Markdown on docs pages alone doesn't pass. When a request names `text/markdown`, return Markdown with `Content-Type: text/markdown` and `Vary: Accept`. Keep returning HTML to browsers.
- **Missing pages have no Markdown body.** A missing page returns the correct `404`, but only as HTML. For `Accept: text/markdown`, return a short Markdown body that links to `llms.txt` and the sitemap.
- **Pages are mostly markup.** The home page has about 896 KB of HTML for about 6 KB of text, so text is about 0.7% of the HTML. Is Agentic measures differently. It counted 5,225 characters of content, reported a content ratio of 1.3%, and sets a target of 5%. An agent that reads the HTML fills its context with markup. Markdown versions solve this for agents. For the HTML, move inline data and repeated markup out of the server response where you can.
- **The Organization JSON-LD is incomplete.** The `Organization` entity has no `description` and no `address`. Its `sameAs` lists GitHub, X, Bluesky, Telegram, and Discord. Add [Wikipedia](https://en.wikipedia.org/wiki/Filecoin) and [Wikidata Q39048590](https://www.wikidata.org/wiki/Q39048590), which Is Agentic confirmed link back to filecoin.io.
- **An unsupported media type gets a `200`.** `Accept: application/json` returns HTML with a `200`. Return a `406` with a body that names the formats the page has.

## Things to add to filecoin.io

- **`/llms.txt`.** Add an [llms.txt](https://llmstxt.org) index with a short summary of Filecoin and a section that tells agents when to use it. Link each way in:
	- the docs, through [docs.filecoin.io/llms.txt](https://docs.filecoin.io/llms.txt)
	- the OpenAPI document at `https://api.filecoin.io/openapi.json`
	- the MCP server at `https://mcp.filecoin.io` and the docs MCP server
	- the agent skill

	Is Agentic found no file that tells agents when to use Filecoin. poc.filecoin.cloud's [`llms.txt`](https://poc.filecoin.cloud/llms.txt) shows the format in about 2.6 KB, with one bullet for each kind of agent.
- **Markdown versions of pages.** Serve each content page at `<path>.md`. Link it from the page's `<head>` with `<link rel="alternate" type="text/markdown">`, and send the same link in a `Link` header. Add `/llms-full.txt` if the content is small enough to read as one file.
- **`/.well-known/api-catalog`.** Serve an RFC 9727 linkset to `https://api.filecoin.io/openapi.json`, its reference, and its health check, like [poc.filecoin.cloud's API catalog](https://poc.filecoin.cloud/.well-known/api-catalog). Serve it as `application/linkset+json`, and answer `HEAD` with the `api-catalog` link relation.
- **MCP server cards.** Serve the server card of `mcp.filecoin.io` at `/.well-known/mcp/server-card.json` and `/.well-known/mcp-server-card`. List the card in `/.well-known/ai-catalog.json`. Is Agentic found the MCP server, but gave half credit for discovery, because no file on filecoin.io lists it.
- **`/.well-known/agent-skills/index.json`.** Publish an index of the Filecoin agent skills, so that `npx skills add https://www.filecoin.io` works. Is Agentic found one official skill on [skills.sh/filecoin-project](https://skills.sh/filecoin-project). poc.filecoin.cloud publishes the `filecoin` skill with [`@hugomrdias/vite-plugin-agent-skills`](https://github.com/hugomrdias/agents/blob/main/packages/vite-plugin-agent-skills/README.md).
- **`/.well-known/integrations.json`.** Declare the REST API, the MCP server, and the `filecoin` CLI for integrations.sh, so that `npx add-mcp find` lists them.
- **Developer links on the home page.** The home page links to docs.filecoin.io pages and to the Filecoin Pay console. It doesn't link to the API reference, the MCP server, or a page for agents. Is Agentic searched for these by name and found none on filecoin.io. Link them from the home page and the footer, with "Filecoin" in their titles.
- **Content signals in `robots.txt`.** This is optional. docs.filecoin.io sends `Content-Signal: ai-train=yes, search=yes, ai-input=yes`. The same line on filecoin.io states the site's policy for AI use.

## Questions for the filecoin.io team

- Which hostname is canonical, `www.filecoin.io` or `filecoin.io`?
- Which site do agents reach first, filecoin.io or docs.filecoin.io? That site should serve `llms.txt` and the `/.well-known/` files and link to the others.
- Can the site add Next.js middleware that answers `Accept: text/markdown`? Does the Markdown come from the CMS, or from a conversion of the rendered HTML?

## How to reproduce

```bash
# llms.txt, Markdown, and discovery files
for h in www.filecoin.io poc.filecoin.cloud; do
	for p in /llms.txt /llms-full.txt /index.md /.well-known/api-catalog /.well-known/integrations.json \
		/.well-known/mcp/server-card.json /.well-known/mcp-server-card /.well-known/agent-skills/index.json \
		/.well-known/ai-catalog.json; do
		curl -s -o /dev/null -w "$h$p %{http_code} %{content_type}\n" "https://$h$p"
	done
done

# Canonical hostname
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://filecoin.io/blog

# Markdown negotiation, Vary, and Link headers
curl -sI -H "Accept: text/markdown" https://www.filecoin.io/ | grep -iE "^(content-type|vary|link):"
curl -sI -H "Accept: text/markdown" https://poc.filecoin.cloud/ | grep -iE "^(content-type|vary|link):"

# Missing page in Markdown
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Accept: text/markdown" https://www.filecoin.io/nope

# Is Agentic reports. These calls are read-only and start no scan
curl -s "https://is-agentic.com/api/v1/report?url=https%3A%2F%2Ffilecoin.io"
curl -s -H "Accept: text/markdown" https://is-agentic.com/scan/poc.filecoin.cloud
```

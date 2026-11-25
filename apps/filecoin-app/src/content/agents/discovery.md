# Markdown and agent discovery

This site serves its docs as Markdown. It also serves files that list its API, its MCP server, and its agent skill, at the paths where agents look for them.

## Markdown versions

Every docs page has a Markdown version. To get it, add `.md` to the path, such as [`/docs/cli.md`](/docs/cli.md), or send `Accept: text/markdown`:

```sh
curl -H 'Accept: text/markdown' https://poc.filecoin.cloud/docs/cli
```

A request that accepts only Markdown gets a Markdown answer from every page. A missing page returns `404` with links to `llms.txt` and the sitemap. An explorer or dashboard page, which has no Markdown version, returns `406`.

## Discovery files

| Path                                                                           | Contents                                                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`/llms.txt`](/llms.txt)                                                       | An index of these docs in Markdown, from [llmstxt.org](https://llmstxt.org)                                                               |
| [`/llms-full.txt`](/llms-full.txt)                                             | Every docs page in one Markdown file                                                                                                      |
| [`/.well-known/api-catalog`](/.well-known/api-catalog)                         | Links to filecoin-api's OpenAPI document, reference, and MCP server, as an [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727) API catalog |
| [`/.well-known/integrations.json`](/.well-known/integrations.json)             | The REST API, the MCP server, and the CLI, with what each needs to authenticate, for [integrations.sh](https://integrations.sh)           |
| [`/.well-known/ai-catalog.json`](/.well-known/ai-catalog.json)                 | The MCP server card's location, as an [AI Catalog](https://ai-catalog.io)                                                                 |
| [`/.well-known/mcp/server-card.json`](/.well-known/mcp/server-card.json)       | Redirects to the MCP server card, as does `/.well-known/mcp-server-card`                                                                  |
| [`/.well-known/agent-skills/index.json`](/.well-known/agent-skills/index.json) | The agent skills index, with the `filecoin` skill                                                                                         |
| [`/sitemap.xml`](/sitemap.xml)                                                 | Every page, also linked from `/robots.txt`                                                                                                |

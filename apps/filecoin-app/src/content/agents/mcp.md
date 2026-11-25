# MCP

filecoin-api's MCP server gives any agent read-only tools for storage providers, data sets, pieces, Filecoin Pay rails, and session keys, on mainnet and calibration. It uses Streamable HTTP and needs no authentication. It cannot store or delete content.

## Install

<!-- install -->

```text
https://mcp.filecoin.io
```

- [Add to Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Filecoin&connectorUrl=https%3A%2F%2Fmcp.filecoin.io)
- [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=filecoin&config=eyJ1cmwiOiJodHRwczovL21jcC5maWxlY29pbi5pbyJ9)
- [Add to VS Code](vscode:mcp/install?%7B%22name%22%3A%22filecoin%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.filecoin.io%22%7D)

<!-- /install -->

Each link opens the app with the server filled in. The app adds the server after you confirm. The Claude link opens claude.ai. The Cursor and VS Code links need the app on your computer.

The [agent plugin](/agents/plugin) adds the server in Claude Code, Codex, and Cursor, with the agent skill. To add the server alone, run a command:

<!-- tabs -->

### Claude Code

```sh
claude mcp add --transport http filecoin https://mcp.filecoin.io
```

### Codex

```sh
codex mcp add filecoin --url https://mcp.filecoin.io
```

### Other agents

```sh
npx -y add-mcp https://mcp.filecoin.io
```

[add-mcp](https://github.com/neon-solutions/add-mcp) writes the server into the configuration of Claude Code, Codex, Cursor, VS Code, and about 20 other agents. It asks which agents to configure, and adds the server to the current project. To add the server for your user instead, add `-g`.

<!-- /tabs -->

In ChatGPT and other apps without an install link, add the URL as a custom connector in the app's settings.

## Tools

The server offers one read-only tool for each [API](/docs/api) data route, plus `search_docs`. Each data tool requires a `network` argument.

| Tool                                               | Reads                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `get_status`                                       | Indexer progress                                                                      |
| `list_providers`, `get_provider`                   | Storage providers                                                                     |
| `list_data_sets`, `get_data_set`                   | Data sets                                                                             |
| `list_data_set_pieces`, `get_piece`, `list_pieces` | Pieces                                                                                |
| `list_rails`, `get_rail`, `list_rail_settlements`  | Filecoin Pay rails and settlements                                                    |
| `list_session_keys`, `list_session_key_events`     | Session keys and their history                                                        |
| `search_docs`                                      | Page excerpts from the [Filecoin docs](https://docs.filecoin.io) that match a `query` |

The server allows 60 requests a minute per IP. [Limits](/docs/api#limits) describes the responses over the limit.

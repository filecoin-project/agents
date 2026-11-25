# API

[filecoin-api](https://api.filecoin.io) serves read-only Filecoin data: storage providers, data sets, pieces, Filecoin Pay rails, and session keys. It reads from an indexer of the Filecoin chain, so its data trails the chain. `/health` reports the latest indexed block. It cannot store, delete, or sign anything.

The interactive reference is at [`/docs`](https://api.filecoin.io/docs), and the OpenAPI 3.1 document is at [`/openapi.json`](https://api.filecoin.io/openapi.json).

To call the API from TypeScript, install [`@filecoin-project/api-client`](https://www.npmjs.com/package/@filecoin-project/api-client) from npm. Its types come from the OpenAPI document, and it runs wherever `fetch` does.

## Routes

`GET /openapi.json` lists every route and its filters. `POST /mcp` is the [MCP server](/agents/mcp). `GET /health` reports the latest indexed block per network, and [`GET /get/{cid}`](#retrieval) redirects to where content can be retrieved. Every data route starts with the API version and the network, `/v1/calibration/...` or `/v1/mainnet/...`, and reads one of: indexer status, storage providers, data sets and their pieces, pieces by owner or PieceCID, Filecoin Pay rails and their settlements, and session keys and their history.

Conventions:

- **Owner** is the address that pays for a data set.
- **Big numbers**, such as IDs, amounts, and epochs, are decimal strings.
- **Pagination** uses `limit` (1 to 200, default 50) and an opaque `cursor`. Each response looks like `{ data, nextCursor }`.
- **Errors** look like `{ error: { code, message } }`.
- **Operation IDs**, such as `listDataSets` and `retrieve`, name every operation in the OpenAPI document, for function calling and generated clients.

## Versioning

The data routes carry their version in the path, `/v1`. The paths from before versioning, such as `/mainnet/providers`, still work as aliases of v1, so older CLIs and clients keep working. They stay for as long as v1 does. `/get/{cid}`, `/health`, and the MCP server have no version.

New routes, new optional parameters, and new response fields land in v1 without notice, so ignore fields you don't know. A breaking change, such as a removed or renamed field, ships under `/v2`. v1 then keeps working for at least six months. Its responses send a `Deprecation` header ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)), and a `Sunset` header ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) with the date when v1 can stop working. No route is deprecated now.

## Retrieval

`GET /get/{cid}?network=mainnet&browser=false` redirects to where the content can be fetched. It never proxies the bytes. `network` defaults to `mainnet`.

| CID                       | `browser`         | Redirect                                                                                                 |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| PieceCID v2 (`bafkzcib…`) | `false` or absent | The provider's `/piece/{cid}`                                                                            |
| PieceCID v2 (`bafkzcib…`) | `true`            | `https://inbrowser.link/ipfs/{root}` when the piece is a folder, otherwise the provider's `/piece/{cid}` |
| Other CID (IPFS content)  | `false` or absent | The provider's `/ipfs/{cid}`, for a folder root or for any file or block inside it                       |
| Other CID (IPFS content)  | `true`            | `https://inbrowser.link/ipfs/{cid}`                                                                      |

`provider={id}` names a provider to redirect to when the indexer has no copy yet. It covers the time between a provider receiving a piece and the indexer seeing the commit. An indexed copy always wins over it. `filecoin put` adds it to the early links it prints before the commit confirms.

When neither the indexer nor `provider` has the CID, the route looks it up in [IPNI](https://cid.contact). It then redirects to a provider that serves the content over https, which can be a provider outside Filecoin. The `X-Source` header says whether the answer came from `index`, `hint`, or `ipni`.

Legacy v1 PieceCIDs (`baga…`) and strings that aren't CIDs return `400`. If no source has the CID, the response is `404`. If IPNI fails after the indexer had no copy, the response is `502`. When several providers store the content, the route prefers endorsed providers, then approved ones, then the oldest copy.

## Limits

- **Rate limits.** 120 requests a minute per IP for the REST API, and 60 for MCP. Responses send the limit in a `RateLimit-Policy` header, such as `"api";q=120;w=60`. Over the limit, requests get `429` with `Retry-After`.
- **Caching.** Browsers do not cache data reads. filecoin-api can reuse a query result for up to 5 seconds, so a read can be that far behind the indexer.
- **No authentication.** Every route is public and read-only.

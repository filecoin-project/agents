# @filecoin-project/api-client

A typed client for the [filecoin-api](../../apps/filecoin-api/README.md) REST API. Its types come from filecoin-api's OpenAPI document, and requests go through [openapi-fetch](https://openapi-ts.dev/openapi-fetch/). filecoin-app uses it, and the `filecoin` CLI will use it for its reads.

It is published to npm. It runs wherever `fetch` does, such as browsers, Node.js, and Cloudflare Workers:

```sh
npm install @filecoin-project/api-client
```

The published package exports JavaScript and declarations from `dist`. Inside this repository, `exports` points to the TypeScript source instead, so filecoin-app and the CLI use it without a build, and `pnpm publish` swaps in `publishConfig.exports`.

```ts
import { createApiClient, unwrap } from '@filecoin-project/api-client'

const api = createApiClient() // https://api.filecoin.io
const { data: providers, nextCursor } = unwrap(
  await api.GET('/{network}/providers', {
    params: { path: { network: 'calibration' } },
  })
)
```

| Export | Contents |
| --- | --- |
| `createApiClient(options)` | An openapi-fetch client. `baseUrl` defaults to `DEFAULT_API_URL`, `https://api.filecoin.io`. |
| `unwrap(result)` | Returns a result's data, or throws an `ApiError` with filecoin-api's error `code` and `message` |
| `ApiError` | `status`, `code`, and `ApiError.isNotFound(error)` |
| `Provider`, `DataSet`, `Piece`, and other schema types | Shortcuts into `components['schemas']` |
| `paths`, `components`, `operations` | The generated types, from `src/schema.ts` |

## How the types stay current

1. filecoin-api's `openapi.test.ts` compares the document the Worker serves with [`apps/filecoin-api/openapi.json`](../../apps/filecoin-api/openapi.json). After a route or schema change, `pnpm --filter filecoin-api gen:openapi` rewrites the file.
2. `pnpm gen` generates `src/schema.ts` from that file with [openapi-typescript](https://openapi-ts.dev/cli).
3. `pnpm test` fails when `src/schema.ts` differs from what `pnpm gen` writes, and `pnpm check` runs both tests.

So a pull request that changes the API also updates the client types, and nothing reads the deployed API at build time.

openapi-typescript needs the TypeScript 5 compiler API, which the repository's TypeScript 7 lacks, so the generator runs it through `pnpm dlx` with TypeScript 5. `pnpm gen` and `pnpm test` need network access the first time pnpm downloads it ([#26](https://github.com/filecoin-project/agents/issues/26)).

## Development

- `pnpm gen`: regenerates `src/schema.ts`
- `pnpm build`: compiles `src` to `dist` with `tsconfig.build.json`, for publishing
- `pnpm test`: checks `src/schema.ts`, then runs `node --test` over `test/**/*.test.ts`
- `pnpm typecheck` and `pnpm lint`

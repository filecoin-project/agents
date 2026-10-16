# hooks-synapse

React hooks for Filecoin that [`@filoz/synapse-react`](https://github.com/FilOzone/synapse-sdk/tree/master/packages/synapse-react) (0.5.1) lacks. They wrap [`@filoz/synapse-core`](https://github.com/FilOzone/synapse-sdk/tree/master/packages/synapse-core) only and follow synapse-react's conventions, so they can move upstream with few changes:

- Read hooks take `{ query? }`. Write hooks take `{ mutation?, onHash? }`, with `mutation` spread before `mutationFn`.
- Query keys start with `synapse-` (see `keys.ts`), and writes invalidate the synapse-react caches they affect.
- Reads use `config.getClient({ chainId })` and accept an optional `chainId`, so explorer pages can read a network other than the wallet's.
- Writes sign with synapse-react's `getSignerClient`: the wallet's connector client, or `sessionKey` when an SP (EIP-712) hook is given one.

| Hook | Wraps | Notes |
| --- | --- | --- |
| `useSessionKey` | `sessionKey.fromSecp256k1`, `watch`, `syncExpirations` | Builds a session key client on the chain's fallback transport and keeps its expirations live |
| `useSessionKeyLogin` | `sessionKey.loginSync` | |
| `useSessionKeyRevoke` | `sessionKey.revokeSync` | |
| `useSessionKeyExpirations` | `sessionKey.getExpirations` | |
| `useAccountSummary` | `pay.getAccountSummary` | Funds, lockups, debt and runway |
| `useDepositWithPermit` | `pay.depositWithPermitSync` | One transaction, no prior approve |
| `useSetOperatorApproval` | `pay.setOperatorApprovalSync` | Allowances are mutation variables, so a form can set them when it submits |
| `useRail` | `pay.getRail` | |
| `useSettleRail` | `pay.settleRailSync` | |
| `useSettleTerminatedRail` | `pay.settleTerminatedRailWithoutValidationSync` | |
| `usePdpDataSet` | `warmStorage.getPdpDataSet` | |
| `useStorageSize` | `warmStorage.getAccountTotalStorageSize` | |
| `useUploadCosts` | `warmStorage.getUploadCosts` | |
| `useTerminateDataSet` | `sp.terminateService`, `sp.waitForTerminateService` | |
| `useDeletePieces` | `sp.schedulePieceDeletions` | Batch delete |

`invalidateStorageQueries` (`utils.ts`) refreshes data sets, storage size and the payment state a storage write changes. synapse-react's storage hooks only refresh their own data sets query, so callers pass it to their `mutation.onSuccess`.

## From synapse-react

synapse-react 0.5.1 fixed the issues these hooks used to work around ([synapse-sdk#1028](https://github.com/FilOzone/synapse-sdk/pull/1028)), so the app uses its hooks directly for:

- `useCreateDataSet`, with `metadata` and `sessionKey`. Core bills a session key's root wallet ([synapse-sdk#1024](https://github.com/FilOzone/synapse-sdk/issues/1024), [#1025](https://github.com/FilOzone/synapse-sdk/issues/1025)).
- `useDataSets({ includePieces: false })` for data set lists, which honours `query` ([synapse-sdk#1023](https://github.com/FilOzone/synapse-sdk/issues/1023)).
- `useUploadPieces`, which streams files and adds them in one signed request, returning the files that failed ([synapse-sdk#1027](https://github.com/FilOzone/synapse-sdk/issues/1027)). It reports bytes per file, so the upload panel shows uploading and adding, not the provider's parking stage. It hashes pieces in the browser, so the PieceCID hasher only loads with the upload panel.
- `getSignerClient` and `SessionKeySignerOptions` ([synapse-sdk#1025](https://github.com/FilOzone/synapse-sdk/issues/1025)).

Also fixed in 0.5.1: `useDepositAndApprove` forwards its props ([synapse-sdk#1022](https://github.com/FilOzone/synapse-sdk/issues/1022)), every write hook spreads `mutation` before `mutationFn`, and read hooks accept `chainId` ([synapse-sdk#1026](https://github.com/FilOzone/synapse-sdk/issues/1026)).

## synapse-react gaps that remain

- No hooks for account summaries, rails, settlement, storage size, upload costs, session keys, a single data set or terminating a data set.
- No permit-only deposit: `useDeposit` needs a prior ERC20 approve, and `useDepositAndApprove` also approves an operator.
- `useApproveOperator` takes its allowances as hook props, and its mutation takes no variables.
- `useDeletePiece` removes one piece per signed request.
- The package has no `sideEffects` field, unlike synapse-core. esbuild and Vite production builds still tree-shake unused hooks, so the field is hygiene, not a measured bundle cost.

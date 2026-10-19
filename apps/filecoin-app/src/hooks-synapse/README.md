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

## synapse-react gaps that remain

- No hooks for account summaries, rails, settlement, storage size, upload costs, session keys, a single data set or terminating a data set.
- No permit-only deposit: `useDeposit` needs a prior ERC20 approve, and `useDepositAndApprove` also approves an operator.
- `useApproveOperator` takes its allowances as hook props, and its mutation takes no variables.
- `useDeletePiece` removes one piece per signed request.
- The package has no `sideEffects` field, unlike synapse-core. esbuild and Vite production builds still tree-shake unused hooks, so the field is hygiene, not a measured bundle cost.

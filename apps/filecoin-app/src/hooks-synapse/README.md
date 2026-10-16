# hooks-synapse

React hooks for Filecoin that [`@filoz/synapse-react`](https://github.com/FilOzone/synapse-sdk/tree/master/packages/synapse-react) (0.5.0) lacks. They wrap [`@filoz/synapse-core`](https://github.com/FilOzone/synapse-sdk/tree/master/packages/synapse-core) only and follow synapse-react's conventions, so they can move upstream with few changes:

- Read hooks take `{ query? }`. Write hooks take `{ mutation?, onHash? }`, with `mutation` spread before `mutationFn`.
- Query keys start with `synapse-` (see `keys.ts`), and writes invalidate the synapse-react caches they affect.
- Reads use `config.getClient({ chainId })`. Unlike synapse-react, every read hook also accepts an optional `chainId`, so explorer pages can read a network other than the wallet's.
- Writes use the wallet's connector client. Hooks for SP (EIP-712) operations also accept `sessionKey` and sign with it when given (`utils.ts`).

| Hook | Wraps | Notes |
| --- | --- | --- |
| `useSessionKey` | `sessionKey.fromSecp256k1`, `watch`, `syncExpirations` | Builds a session key client on the chain's fallback transport and keeps its expirations live |
| `useSessionKeyLogin` | `sessionKey.loginSync` | |
| `useSessionKeyRevoke` | `sessionKey.revokeSync` | |
| `useSessionKeyExpirations` | `sessionKey.getExpirations` | |
| `useAccountSummary` | `pay.getAccountSummary` | Funds, lockups, debt and runway |
| `useDepositWithPermit` | `pay.depositWithPermitSync` | One transaction, no prior approve |
| `useSetOperatorApproval` | `pay.setOperatorApprovalSync` | Custom rate, lockup and period allowances |
| `useRail` | `pay.getRail` | |
| `useSettleRail` | `pay.settleRailSync` | |
| `useSettleTerminatedRail` | `pay.settleTerminatedRailWithoutValidationSync` | |
| `usePdpDataSets` | `warmStorage.getPdpDataSets` with `paginate` | Doesn't fetch every piece; honours `query` |
| `usePdpDataSet` | `warmStorage.getPdpDataSet` | |
| `useStorageSize` | `warmStorage.getAccountTotalStorageSize` | |
| `useUploadCosts` | `warmStorage.getUploadCosts` | |
| `useCreateDataSet` | `sp.createDataSet`, `sp.waitForCreateDataSet` | Adds metadata and session key support. With a session key, the payer is the key's root wallet |
| `useTerminateDataSet` | `sp.terminateService`, `sp.waitForTerminateService` | |
| `useDeletePieces` | `sp.schedulePieceDeletions` | Batch delete |
| `useUpload` | `sp.uploadPieceStreaming`, `sp.findPiece`, `sp.addPieces`, `sp.waitForAddPieces` | Core-only (synapse-react's `useUpload` uses synapse-sdk; its core-only `useUploadSimple` buffers each file and has no progress, no session key, and one failed file rejects the whole upload). Streams 4 files at a time, tracks progress per file and adds every parked piece in one signed request. Waits for the add-pieces transaction to confirm and returns each piece's confirmed id; failed files come back in `failed` ([synapse-sdk#1027](https://github.com/FilOzone/synapse-sdk/issues/1027)) |

## synapse-core issues found while building this

- `sp.waitForAddPieces` keeps polling while `piecesAdded` is `false`, which is also true of a `rejected` status, so a rejected add-pieces transaction surfaces as the 5 minute timeout rather than `WaitForAddPiecesRejectedError`. `sp.waitForCreateDataSet` has the same problem with `dataSetCreated` ([synapse-sdk#1014](https://github.com/FilOzone/synapse-sdk/issues/1014)).

## synapse-react issues found while building this

- `useDepositAndApprove` passes only `{ amount }` to core, so its `token`, `operator` and allowance props are ignored ([synapse-sdk#1022](https://github.com/FilOzone/synapse-sdk/issues/1022)).
- `useDataSets` ignores `props.query`, and it loads every piece of every data set ([synapse-sdk#1023](https://github.com/FilOzone/synapse-sdk/issues/1023)).
- `useDeposit`, `useWithdraw` and `useDepositAndApprove` spread `mutation` after `mutationFn`; the other hooks spread it before ([synapse-sdk#1022](https://github.com/FilOzone/synapse-sdk/issues/1022)).
- `useCreateDataSet` has no metadata support (it's commented out) ([synapse-sdk#1024](https://github.com/FilOzone/synapse-sdk/issues/1024)) and cannot sign with a session key ([synapse-sdk#1025](https://github.com/FilOzone/synapse-sdk/issues/1025)).
- The package has no `sideEffects` field, unlike synapse-core, and its root entry re-exports `useUpload`, which imports `@filoz/synapse-sdk`. esbuild and Vite production builds still tree-shake synapse-sdk out when `useUpload` is unused, so the field is hygiene, not a measured bundle cost.
- No hook takes a `chainId`, so reading a network other than the connected one needs custom hooks ([synapse-sdk#1026](https://github.com/FilOzone/synapse-sdk/issues/1026)).

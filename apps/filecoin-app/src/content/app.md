# Web app

[filecoin-app](https://poc.filecoin.cloud) has three parts:

- **Explorer** (`/mainnet`, `/calibration`): public pages for data sets, pieces, storage providers, Filecoin Pay rails and settlements, session keys, and each address. Search with `/` or ⌘K from any page.
- **Dashboard** (`/dashboard`): connect a wallet to manage your Filecoin Pay account, the Warm Storage approval, data sets, uploads, rails, and session keys.
- **Setup page** (`/dashboard/setup`): review and approve a request from a browser agent.

## Session keys

A session key lets a tool sign storage requests for your wallet. It can create data sets, add pieces, schedule piece removals, and end service, but it can never move funds. Keys you make in the dashboard stay in this browser. Keys that a tool makes, such as `filecoin login`, stay on that tool's machine.

The session keys page lists every key your wallet approved, with when each permission expires. Revoke a key there to stop the tool that holds it.

## Setup links

Browser agents send the wallet owner to `/dashboard/setup`, through a link or the `prepare_setup_request` tool. The page lists what the link asks for as steps, each with its status read from the chain: authorize a session key, approve Warm Storage, and fund Filecoin Pay. You review each step, change what you need, and approve it with your wallet. Each step is its own transaction, so nothing is signed until you click. When the wallet holds the USDFC still missing, one transaction approves Warm Storage and deposits it. When every step is done, go back to the tool.

The parameters follow the [Filecoin Pay console](https://pay.filecoin.cloud/console)'s setup links, which the `filecoin` CLI sends, so the same link works on both:

| Parameter | Meaning |
| --- | --- |
| `network` | `mainnet` or `calibration`. Required. The page asks to switch the wallet when it is on the other network |
| `authorize` or `signer` | Session key address to approve. The private key stays with the tool that made it |
| `scopes` | Comma-separated permissions: `createDataSet`, `addPieces`, `schedulePieceRemovals`, `terminateService`. Required with a session key. You can drop a permission but not add one |
| `name` | Suggested session key name, up to 64 characters, recorded on chain. Default: `filecoin-app` |
| `days` | Suggested days until the approval expires, up to 365. Default: 30 |
| `deposit` | USDFC to add to Filecoin Pay, as a decimal amount |
| `balance` | USDFC the account needs available in Filecoin Pay |
| `operator` | `fwss`. Without `deposit` or `balance`, the link asks only for the Warm Storage approval |
| `approval` | `unlimited`: Warm Storage counts as approved only without spending limits. If yours has limits, the page shows them and offers to remove them |

A value the page cannot read refuses the whole link, and the page says why. Ask the tool for a new link.

## WebMCP tools

filecoin-app registers [WebMCP](https://webmachinelearning.github.io/webmcp/) tools, so a browser agent can prepare a setup request and read the account and its storage:

| Tool | Where | What it does |
| --- | --- | --- |
| `prepare_setup_request` | Every page | Checks a request with the parameters above and opens the prefilled setup page. It never signs anything |
| `get_setup_status` | `/dashboard/setup` | Reports whether a wallet is connected and on the right network, and the status of each step |
| `get_account_summary` | Every page | Reports a wallet's Filecoin Pay funds, monthly spend, runway, and Warm Storage approval |
| `list_data_sets` | Every page | Lists a wallet's data sets |
| `list_pieces` | Every page | Lists a data set's pieces, each with a retrieval link |
| `lookup_piece` | Every page | Finds the data sets that hold a PieceCID v2 |
| `list_session_keys` | Every page | Lists the session keys a wallet approved |

The read tools default to the connected wallet and the network in the page address. WebMCP is an early preview. It works in Chrome 149 and later on poc.filecoin.cloud, and in the ChatGPT desktop app's browser, where the tools are called site tools. Other browsers ignore the tools, and agents use setup links instead.

import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'

/**
 * Protocol versions the SDK negotiates that include Streamable HTTP, which
 * arrived in `2025-03-26`. Versions are dates, so they compare as strings.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 */
const STREAMABLE_HTTP_VERSIONS = SUPPORTED_PROTOCOL_VERSIONS.filter(
  (version) => version >= '2025-03-26'
)

/**
 * Name of the MCP server:`mcp.filecoin.io` in reverse-DNS form. `serverInfo`,
 * the server card and the MCP registry entry all use it, so clients see one
 * name before and after they connect.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-server-card/blob/main/docs/discovery.md#consistency-with-runtime-behavior
 */
export const MCP_SERVER_NAME = 'io.filecoin/mcp'

/** Display name of the MCP server, shared by `serverInfo` and the card. */
export const MCP_SERVER_TITLE = 'Filecoin'

/** Media type of an MCP server card. */
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json'

/**
 * App paths that serve the card. `/mcp/server-card` is the location SEP-2127
 * reserves next to the `/mcp` endpoint; the MCP hosts serve it at
 * `/server-card`. The `.well-known` paths come from older drafts, which
 * scanners still check.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-server-card/blob/main/docs/discovery.md#hosted-server-card-location
 */
export const SERVER_CARD_PATHS = [
  '/mcp/server-card',
  '/.well-known/mcp/server-card.json',
  '/.well-known/mcp-server-card',
]

/**
 * Build the MCP server card: the server's identity and its Streamable HTTP
 * endpoint, for clients that discover it before they connect.
 *
 * @param mcpUrl - Public URL of the MCP endpoint.
 * @param version - filecoin-api version, as reported in `serverInfo`.
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md
 */
export function mcpServerCard(mcpUrl: string, version: string) {
  return {
    $schema:
      'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: MCP_SERVER_NAME,
    title: MCP_SERVER_TITLE,
    version,
    description:
      'Read-only Filecoin data: storage providers, data sets, pieces, Filecoin Pay rails, and session keys on mainnet and calibration, and a search of the Filecoin docs.',
    websiteUrl: 'https://poc.filecoin.cloud/docs/api',
    repository: {
      url: 'https://github.com/filecoin-project/agents',
      source: 'github',
      subfolder: 'apps/filecoin-api',
    },
    remotes: [
      {
        type: 'streamable-http',
        url: mcpUrl,
        supportedProtocolVersions: STREAMABLE_HTTP_VERSIONS,
      },
    ],
  }
}

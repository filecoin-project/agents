/**
 * Build-time configuration read from `VITE_*` environment variables.
 *
 * @see https://vite.dev/guide/env-and-mode
 */
export const env = {
  /** Base URL of the filecoin-api REST API. */
  filApiUrl:
    import.meta.env.VITE_FILECOIN_API_URL ?? 'https://api.filecoin.cloud',
  /**
   * URL of filecoin-api's MCP server. Follows `VITE_FILECOIN_API_URL` when
   * only that is set, so a local filecoin-api serves both.
   */
  mcpUrl:
    import.meta.env.VITE_FILECOIN_MCP_URL ??
    (import.meta.env.VITE_FILECOIN_API_URL
      ? `${import.meta.env.VITE_FILECOIN_API_URL}/mcp`
      : 'https://mcp.filecoin.cloud'),
  /** Public origin of filecoin-app, for canonical and Open Graph URLs. */
  siteUrl: import.meta.env.VITE_SITE_URL ?? 'https://poc.filecoin.cloud',
}

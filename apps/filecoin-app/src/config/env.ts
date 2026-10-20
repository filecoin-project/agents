/**
 * Build-time configuration read from `VITE_*` environment variables.
 *
 * @see https://vite.dev/guide/env-and-mode
 */
export const env = {
  /** Base URL of the filecoin-api REST API that the site advertises. */
  filApiUrl: import.meta.env.VITE_FILECOIN_API_URL ?? 'https://api.filecoin.io',
  /**
   * Base URL the app's API client fetches from. It defaults to filecoin-api's
   * Custom Domain, because server renders run on the `filecoin.cloud` zone,
   * where a Worker's `fetch()` can't reach the Worker route that serves
   * `api.filecoin.io` and gets the zone's fallback origin instead.
   *
   * @see https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication
   */
  filApiFetchUrl:
    import.meta.env.VITE_FILECOIN_API_URL ?? 'https://api.filecoin.cloud',
  /**
   * URL of filecoin-api's MCP server. Follows `VITE_FILECOIN_API_URL` when
   * only that is set, so a local filecoin-api serves both.
   */
  mcpUrl:
    import.meta.env.VITE_FILECOIN_MCP_URL ??
    (import.meta.env.VITE_FILECOIN_API_URL
      ? `${import.meta.env.VITE_FILECOIN_API_URL}/mcp`
      : 'https://mcp.filecoin.io'),
  /** Public origin of filecoin-app, for canonical and Open Graph URLs. */
  siteUrl: import.meta.env.VITE_SITE_URL ?? 'https://poc.filecoin.cloud',
}

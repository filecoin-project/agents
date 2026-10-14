/**
 * Build-time configuration read from `VITE_*` environment variables.
 *
 * @see https://vite.dev/guide/env-and-mode
 */
export const env = {
  /** Base URL of the filecoin-api REST API. */
  filApiUrl:
    import.meta.env.VITE_FILECOIN_API_URL ?? 'https://api.filecoin.cloud',
  /** Public origin of filecoin-app, for canonical and Open Graph URLs. */
  siteUrl: import.meta.env.VITE_SITE_URL ?? 'https://poc.filecoin.cloud',
}

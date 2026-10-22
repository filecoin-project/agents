import { isServer } from '@tanstack/react-query'

/**
 * Wrap a loader prefetch for a table that renders its own pending state, so
 * the loader awaits it on the server and not in the browser.
 *
 * `@tanstack/react-router-ssr-query` streams queries that are still pending
 * when the server renders. The streamed data can reach the browser before
 * React hydrates, so the browser renders rows where the server HTML has a
 * skeleton, and React reports a hydration mismatch (error #418). Awaiting on
 * the server sends the settled query with the page instead. In the browser,
 * client-side navigation doesn't wait for the table.
 *
 * @param prefetch - Promise from `queryClient.prefetchInfiniteQuery`.
 * @param server - Whether this runs on the server; defaults to TanStack Query's `isServer`.
 * @returns The prefetch on the server, `undefined` in the browser.
 * @see https://tanstack.com/router/latest/docs/integrations/query
 * @see https://react.dev/errors/418
 */
export function awaitOnServer(
  prefetch: Promise<void>,
  server: boolean = isServer
): Promise<void> | undefined {
  return server ? prefetch : undefined
}

import { CliError } from 'clipact'

/** Error names from viem and iso-web for an unreachable or failing endpoint. */
const UNAVAILABLE = new Set([
  'HttpRequestError',
  'RpcRequestError',
  'WebSocketRequestError',
  'NetworkError',
  'FetchError',
  'ResourceUnavailableRpcError',
  'InternalRpcError',
  'LimitExceededRpcError',
])

/** Error names for a request that took too long. */
const TIMEOUT = new Set(['TimeoutError'])

/**
 * HTTP status of a filecoin-api error, or `undefined` for any other error.
 * Matched by name, like the others, so this module does not import the API
 * client.
 */
function apiStatus(error: Error): number | undefined {
  if (error.name !== 'ApiError' || !('status' in error)) return undefined
  return Number(error.status)
}

/** Whether `error` is undici's failure to reach a host, from `fetch`. */
function isFetchFailure(error: Error): boolean {
  return error instanceof TypeError && error.message === 'fetch failed'
}

/** The error and its causes, outermost first. */
function* causes(error: unknown): Generator<Error> {
  let current = error
  for (let depth = 0; current instanceof Error && depth < 10; depth++) {
    yield current
    current = current.cause
  }
}

/** First line of an error message, without viem's detail blocks. */
export function firstLine(error: Error): string {
  return error.message.split('\n')[0] ?? error.name
}

/**
 * Translate RPC and HTTP failures from viem, synapse-core, and filecoin-api into
 * clipact's transient codes. clipact marks them retryable only for read-only
 * and idempotent commands; put and delete wrap errors with their operation
 * first, so they never reach this hook. Loaded only when a handler throws
 * something other than a `CliError`.
 *
 * @see https://github.com/hugomrdias/agents/blob/main/docs/agent-cli/framework-design.md#output-and-errors
 */
export default function mapError(error: unknown): CliError | undefined {
  for (const cause of causes(error)) {
    const status = apiStatus(cause)
    if (status === 429) {
      return new CliError({
        code: 'rate_limited',
        message: `filecoin-api limited the request rate: ${firstLine(cause)}`,
        cause: error,
      })
    }
    if (TIMEOUT.has(cause.name)) {
      return new CliError({
        code: 'timeout',
        message: `A request timed out: ${firstLine(cause)}`,
        cause: error,
      })
    }
    if (
      UNAVAILABLE.has(cause.name) ||
      (status !== undefined && status >= 500) ||
      isFetchFailure(cause)
    ) {
      return new CliError({
        code: 'service_unavailable',
        message: `A service did not respond: ${firstLine(cause)}`,
        cause: error,
      })
    }
  }
  return undefined
}

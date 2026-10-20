import { createMiddleware } from 'hono/factory'
import { ApiError } from '../errors.ts'
import type { AppEnv } from '../types.ts'

/** Rate limiter binding names declared in `wrangler.jsonc`. */
type RateLimitBinding = 'RATE_LIMIT_API' | 'RATE_LIMIT_MCP'

/**
 * `RateLimit-Policy` value for each binding, in the IETF RateLimit header
 * fields format: `q` requests per `w` seconds. Keep these in sync with the
 * `simple` limits in `wrangler.jsonc`, which the binding can't report.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitBinding, string> = {
  RATE_LIMIT_API: '"api";q=120;w=60',
  RATE_LIMIT_MCP: '"mcp";q=60;w=60',
}

/**
 * Limit requests per client IP with a Workers Rate Limiting binding, and send
 * the limit in a `RateLimit-Policy` header on every response.
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export function rateLimit(binding: RateLimitBinding) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Set before the limit check so 429 responses carry it too.
    c.header('RateLimit-Policy', RATE_LIMIT_POLICIES[binding])
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
    const { success } = await c.env[binding].limit({ key: `${binding}:${ip}` })
    if (!success) {
      c.header('Retry-After', '60')
      throw new ApiError(429, 'rate_limited', 'Too many requests, retry later')
    }
    await next()
  })
}

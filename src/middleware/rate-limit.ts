import { rateLimiter } from "hono-rate-limiter";
import type { Context } from "hono";

/**
 * Extract client IP for rate limiting.
 * Only trusts X-Forwarded-For when TRUSTED_PROXY=true (i.e. behind a known
 * reverse proxy like nginx, Cloudflare, or a load balancer).
 */
function getClientKey(c: Context): string {
  const trustProxy = process.env.TRUSTED_PROXY === "true";

  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }

  return c.req.header("x-real-ip") || "unknown";
}

/**
 * Strict rate limiter for expensive API-calling endpoints:
 * translation (OpenRouter) and transcription (Groq).
 * 10 requests per minute per client.
 */
export const expensiveRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 10,
  keyGenerator: getClientKey,
  message: { error: "Too many requests. Translation and transcription are limited to 10 requests per minute." },
});

/**
 * Search rate limiter: 60 requests per minute per client.
 */
export const searchRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: getClientKey,
  message: { error: "Too many search requests. Limited to 60 per minute." },
});

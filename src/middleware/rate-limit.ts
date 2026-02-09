import { rateLimiter } from "hono-rate-limiter";
import type { Context } from "hono";

/**
 * Extract client IP for rate limiting.
 * Only trusts X-Forwarded-For when TRUSTED_PROXY=true (i.e. behind a known
 * reverse proxy like nginx, Cloudflare, or a load balancer).
 * Falls back to Bun's socket address to avoid a shared "unknown" bucket.
 */
function getClientKey(c: Context): string {
  const trustProxy = process.env.TRUSTED_PROXY === "true";

  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;

    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp;
  }

  // Bun exposes the remote address on the raw request object
  try {
    const addr = (c.env as Record<string, unknown>)?.remoteAddr ??
      ((c.req.raw as unknown as Record<string, unknown>)?.["__bun_addr"] as string | undefined);
    if (typeof addr === "string" && addr) return addr;
  } catch { /* ignore */ }

  // Last resort: hash of user-agent + accept-language to differentiate clients
  const ua = c.req.header("user-agent") || "";
  const lang = c.req.header("accept-language") || "";
  return `anon:${ua.slice(0, 32)}:${lang.slice(0, 16)}`;
}

/**
 * General rate limiter for all API endpoints: 120 requests per minute per client.
 * Applied broadly to protect read-heavy endpoints that lack specific limits.
 */
export const apiRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: getClientKey,
  message: { error: "Too many requests. Limited to 120 requests per minute." },
});

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

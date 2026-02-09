import crypto from "crypto";
import type { Context, Next } from "hono";

/**
 * Middleware that restricts access to internal-only endpoints.
 * Validates the X-Internal-Secret header against INTERNAL_API_SECRET env var.
 * Used for endpoints that should only be called by the frontend proxy (sabeel),
 * not by external clients directly.
 */
export async function internalAuth(c: Context, next: Next) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[internal-auth] INTERNAL_API_SECRET is not set — blocking request");
    return c.json({ error: "Service misconfigured" }, 503);
  }

  const provided = c.req.header("x-internal-secret");
  if (!provided) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (secretBuf.length !== providedBuf.length || !crypto.timingSafeEqual(secretBuf, providedBuf)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
}

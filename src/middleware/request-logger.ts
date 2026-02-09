import type { MiddlewareHandler } from "hono";

/**
 * Lightweight request logging middleware.
 * Logs one line per request: method, path, status, duration.
 */
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  console.log(`${c.req.method} ${c.req.path} ${status} ${duration}ms`);
};

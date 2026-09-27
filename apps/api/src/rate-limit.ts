/**
 * Small process-local limiter for unauthenticated or invite-code endpoints.
 * It is intentionally conservative and fail-closed per API process; the
 * reverse proxy remains responsible for broad traffic protection in staging.
 */
export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export function createRateLimiter(options: RateLimiterOptions): (key: string) => boolean {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const current = buckets.get(key);
    if (current === undefined || now - current.startedAt >= options.windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= options.maxRequests;
  };
}

/**
 * The API is normally behind the project's loopback Nginx proxy. Nginx
 * overwrites X-Real-IP, while direct local calls fall back to Fastify's IP.
 */
export function clientAddress(request: { ip: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = request.headers["x-real-ip"] ?? request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim() !== "") {
    return forwarded.split(",")[0]?.trim() || request.ip;
  }
  if (Array.isArray(forwarded) && forwarded[0]?.trim() !== "") return forwarded[0].trim();
  return request.ip;
}

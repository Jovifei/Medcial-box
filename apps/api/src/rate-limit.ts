/**
 * Small process-local limiter for unauthenticated or invite-code endpoints.
 * It is intentionally conservative and fail-closed per API process; the
 * reverse proxy remains responsible for broad traffic protection in staging.
 */
export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  /** Bound unique active client buckets to avoid memory growth under IP churn. */
  maximumBuckets?: number;
}

export function createRateLimiter(options: RateLimiterOptions): (key: string) => boolean {
  const maximumBuckets = options.maximumBuckets ?? 4096;
  if (!Number.isInteger(maximumBuckets) || maximumBuckets < 1) {
    throw new RangeError("maximumBuckets must be a positive integer");
  }

  const buckets = new Map<string, { startedAt: number; count: number }>();

  const pruneExpired = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.startedAt >= options.windowMs) buckets.delete(key);
    }
  };

  return (key: string): boolean => {
    const now = Date.now();
    const current = buckets.get(key);
    if (current !== undefined && now - current.startedAt < options.windowMs) {
      current.count += 1;
      return current.count <= options.maxRequests;
    }
    if (current !== undefined) buckets.delete(key);

    // A rotating set of unique/spoofed addresses must not grow this process
    // without bound. Prune first; if all remaining buckets are active, fail
    // closed for a new identity rather than evicting an active limiter.
    if (buckets.size >= maximumBuckets) {
      pruneExpired(now);
      if (buckets.size >= maximumBuckets) return false;
    }
    buckets.set(key, { startedAt: now, count: 1 });
    return true;
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

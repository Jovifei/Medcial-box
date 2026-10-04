import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../dist/rate-limit.js";

test("rate limiter bounds active unique client buckets and fails closed", () => {
  const allow = createRateLimiter({ windowMs: 60_000, maxRequests: 2, maximumBuckets: 2 });
  assert.equal(allow("client-a"), true);
  assert.equal(allow("client-b"), true);
  assert.equal(allow("client-c"), false);
  assert.equal(allow("client-a"), true);
  assert.equal(allow("client-a"), false);
});

test("rate limiter rejects invalid bucket capacity", () => {
  assert.throws(
    () => createRateLimiter({ windowMs: 60_000, maxRequests: 1, maximumBuckets: 0 }),
    /positive integer/,
  );
});

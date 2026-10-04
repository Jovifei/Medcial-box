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

test("expired buckets free capacity without resetting active clients", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const allow = createRateLimiter({ windowMs: 100, maxRequests: 1, maximumBuckets: 2 });
  assert.equal(allow("old"), true);
  now = 1_050;
  assert.equal(allow("active"), true);
  assert.equal(allow("new"), false);
  now = 1_100;
  assert.equal(allow("new"), true);
  assert.equal(allow("active"), false);
  now = 1_150;
  assert.equal(allow("active"), true);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const nginx = fs.readFileSync(
  path.resolve(import.meta.dirname, "../deploy/nginx.staging.conf.example"),
  "utf8",
);

test("staging proxy accepts the API photo envelope", () => {
  assert.match(nginx, /client_max_body_size\s+12m;/);
  assert.doesNotMatch(nginx, /client_max_body_size\s+1m;/);
});

test("staging proxy does not time out before local recognition can finish", () => {
  assert.match(nginx, /proxy_read_timeout\s+75s;/);
});

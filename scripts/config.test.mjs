import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMiniProgram, validateClientConfig } from "./prepare-miniprogram.mjs";
import { validateStagingEnvironment } from "./check-staging.mjs";

test("client config accepts only a public HTTPS origin without embedded credentials", () => {
  const id = "wx1234567890abcdef";
  assert.deepEqual(validateClientConfig(id, "https://medbox.example.invalid/"), {
    appId: id, apiBase: "https://medbox.example.invalid",
  });
  for (const url of ["http://medbox.example.invalid", "https://a:secret@medbox.example.invalid",
    "https://medbox.example.invalid/api/v1", "https://medbox.example.invalid/?secret=value",
    "https://localhost", "https://medbox.example.invalid/#secret"]) {
    assert.throws(() => validateClientConfig(id, url));
  }
  assert.throws(() => validateClientConfig("touristappid", "https://medbox.example.invalid"));
  assert.deepEqual(validateClientConfig(id, "http://127.0.0.1:13301", { local: true }), {
    appId: id, apiBase: "http://127.0.0.1:13301",
  });
  assert.throws(() => validateClientConfig(id, "http://medbox.example.invalid", { local: true }));
});

test("generated mini-program bundle keeps source intact and excludes private settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "medbox-client-test-"));
  try {
    const source = join(root, "apps", "miniprogram");
    await mkdir(join(source, "services"), { recursive: true });
    const original = '{"appid":"touristappid","setting":{"urlCheck":true}}';
    await writeFile(join(source, "project.config.json"), original);
    await writeFile(join(source, "services", "config.ts"), 'export const API_BASE = "http://127.0.0.1:3000";');
    await writeFile(join(source, ".env"), "SECRET=SYNTHETIC_PRIVATE_FIXTURE");
    await writeFile(join(source, "project.private.config.json"), '{"private":"SYNTHETIC_PRIVATE_FIXTURE"}');
    const output = await prepareMiniProgram({
      root, appId: "wx1234567890abcdef", apiBase: "https://medbox.example.invalid",
    });
    assert.equal(await readFile(join(source, "project.config.json"), "utf8"), original);
    assert.equal(JSON.parse(await readFile(join(output, "project.config.json"), "utf8")).appid, "wx1234567890abcdef");
    assert.match(await readFile(join(output, "services", "config.ts"), "utf8"), /https:\/\/medbox.example.invalid/);
    await assert.rejects(access(join(output, ".env")));
    await assert.rejects(access(join(output, "project.private.config.json")));
    const localOutput = await prepareMiniProgram({
      root, appId: "wx1234567890abcdef", apiBase: "http://127.0.0.1:13301", local: true,
    });
    const localProject = JSON.parse(await readFile(join(localOutput, "project.config.json"), "utf8"));
    assert.equal(localProject.appid, "wx1234567890abcdef");
    assert.equal(localProject.setting.urlCheck, false);
    assert.match(await readFile(join(localOutput, "services", "config.ts"), "utf8"), /http:\/\/127\.0\.0\.1:13301/);
    await assert.rejects(access(join(localOutput, "project.private.config.json")));
  } finally {
    // root was created by this test with mkdtemp, never supplied by a user.
    await rm(root, { recursive: true, force: true });
  }
});

test("staging rejects placeholders/default credentials without echoing secret values", () => {
  const env = {
    POSTGRES_PASSWORD: "synthetic-test-password-123",
    WECHAT_APP_ID: "wx1234567890abcdef",
    WECHAT_APP_SECRET: "synthetic-secret-for-unit-test",
  };
  assert.doesNotThrow(() => validateStagingEnvironment(env));
  for (const overrides of [
    { POSTGRES_PASSWORD: "local-dev-only" }, { WECHAT_APP_ID: "touristappid" },
    { WECHAT_APP_SECRET: "" }, { STAGING_API_PORT: "80" },
  ]) assert.throws(() => validateStagingEnvironment({ ...env, ...overrides }));
});


test("staging reverse proxy stays aligned with photo and recognition request limits", async () => {
  const nginx = await readFile(
    join(import.meta.dirname, "..", "deploy", "nginx.staging.conf.example"),
    "utf8",
  );
  assert.match(nginx, /client_max_body_size\s+12m;/,
    "8 MiB raw photos expand in base64; HTTPS proxy must allow the API's 12 MiB request body");
  assert.match(nginx, /proxy_read_timeout\s+75s;/,
    "proxy timeout must not cut off the 60–70 second client recognition window");
});

test("Android release source never falls back to the debug keystore", async () => {
  const gradle = await readFile(
    join(import.meta.dirname, "..", "apps", "flutter", "android", "app", "build.gradle.kts"),
    "utf8",
  );
  assert.doesNotMatch(gradle, /signingConfig\s*=\s*signingConfigs\.getByName\(["']debug["']\)/);
});

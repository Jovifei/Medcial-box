import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMiniProgramPackage } from "./check-miniprogram-package.mjs";
import { prepareMiniProgram } from "./prepare-miniprogram.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mini-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mini = join(root, "apps", "miniprogram");
  await mkdir(join(mini, "services"), { recursive: true });
  const write = (name, value) => writeFile(join(mini, name), typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
  await write("project.config.json", { appid:"wx1234567890abcdef", projectname:"JF小药箱-测试环境",
    setting: { minified: true, uploadWithSourceMap: false }, packOptions: { ignore: [{type:"folder",value:"test"},{type:"folder",value:"typings"}] } });
  await write("app.json", { sitemapLocation: "sitemap.json", lazyCodeLoading: "requiredComponents" });
  await write("sitemap.json", { rules: [{ action: "disallow", page: "*" }] });
  await write("services/config.ts", 'export const API_BASE = "https://medbox.example.invalid";');
  return { root, mini, write };
}

test("valid private package passes", async (t) => {
  const {mini} = await fixture(t);
  assert.equal((await checkMiniProgramPackage(mini)).ok, true);
});
test("original empty sitemap and disabled optimizations fail", async (t) => {
  const {mini,write} = await fixture(t);
  await write("sitemap.json", {rules:[]});
  await write("app.json", {});
  await write("project.config.json", {appid:"wx1234567890abcdef",projectname:"JF小药箱-测试环境",setting:{minified:false,uploadWithSourceMap:true}});
  assert.equal((await checkMiniProgramPackage(mini)).errors.length, 4);
});
test("oversized image and actual package files fail budgets", async (t) => {
  const {mini,write} = await fixture(t);
  await write("logo.png", Buffer.alloc(201 * 1024));
  await write("oversized.js", Buffer.alloc(1.5 * 1024 * 1024));
  const result = await checkMiniProgramPackage(mini);
  assert.ok(result.errors.some(e=>e.includes("media exceeds")));
  assert.ok(result.errors.some(e=>e.includes("main package exceeds")));
});
test("generated project excludes development files and preserves runtime config", async (t) => {
  const {root,mini,write} = await fixture(t);
  await mkdir(join(mini,"test"));
  await mkdir(join(mini,"typings"));
  await write("test/test.mjs", "test");
  await write("typings/index.d.ts", "types");
  await write("package.json", {});
  await write("tsconfig.json", {});
  await write("app.ts.map", "map");
  const output = await prepareMiniProgram({root,appId:"wx1234567890abcdef",apiBase:"http://127.0.0.1:13300",local:true});
  assert.ok(await readFile(join(output, "tsconfig.json"), "utf8"));
  assert.ok(await readFile(join(output, "package.json"), "utf8"));
  for (const name of ["test/test.mjs","typings/index.d.ts","app.ts.map"]) {
    await assert.rejects(readFile(join(output,name)), {code:"ENOENT"});
  }
  assert.match(await readFile(join(output,"services/config.ts"),"utf8"), /13300/);
  assert.equal((await checkMiniProgramPackage(output)).ok, false, "local-trial package is not release-safe");
  assert.equal((await checkMiniProgramPackage(output, { mode: "source" })).ok, true);
  const staging = await prepareMiniProgram({root,appId:"wx1234567890abcdef",apiBase:"https://medbox.example.invalid"});
  assert.equal((await checkMiniProgramPackage(staging)).ok, true, "generated HTTPS package is release-safe");
});
test("source project marker and loopback API fail the default release gate", async (t) => {
  const {mini,write} = await fixture(t);
  await write("project.config.json", {appid:"wx1234567890abcdef",projectname:"JF小药箱-源码-禁止上传",
    setting:{minified:true,uploadWithSourceMap:false},packOptions:{ignore:[]}});
  await write("services/config.ts", 'export const API_BASE = "http://127.0.0.1:13307";');
  const release = await checkMiniProgramPackage(mini);
  assert.equal(release.ok, false);
  assert.ok(release.errors.some(e=>e.includes("source project")));
  assert.ok(release.errors.some(e=>e.includes("HTTPS")));
  assert.equal((await checkMiniProgramPackage(mini,{mode:"source"})).ok, true);
});

test("unexcluded test files are rejected", async (t) => {
  const {mini,write} = await fixture(t);
  await write("project.config.json", {setting:{minified:true,uploadWithSourceMap:false}});
  await mkdir(join(mini,"test"));
  await write("test/leak.mjs", "test");
  assert.ok((await checkMiniProgramPackage(mini)).errors.some(e=>e.includes("development or secret")));
});

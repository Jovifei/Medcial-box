import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("staging-backup.sh", import.meta.url));
const linuxOnly = { skip: process.platform !== "linux" ? "Linux staging shell contract; run in Linux CI" : false };
const api = "a".repeat(64);
const other = "b".repeat(64);
const image = `sha256:${"c".repeat(64)}`;
const photoKey = "leaflets/family-fixture/medicine-fixture/photo-fixture.jpg";

// This adapter never contacts Docker, a database, or an application. The dump
// is JSON metadata; photo bytes are archived with the host's real tar command.
const dockerAdapter = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.env.MEDBOX_BACKUP_FIXTURE;
const statePath = path.join(root, "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const reject = () => { console.error("Unexpected adapter invocation"); process.exit(95); };
if (args.join(" ") === "compose version") process.exit(state.legacy ? 1 : 0);
if (args.includes("ps") && args.includes("api")) {
  if (state.mode === "compose-ps-fail") process.exit(93);
  console.log(state.mode === "missing" ? "" : state.mode === "multiple" ? state.api + "\n" + state.other : state.api);
} else if (args[0] === "inspect") {
  if (state.mode === "stale") process.exit(94);
  if (args[2] === "{{.State.Status}}") {
    if (state.mode === "consumer-inspect-fail") process.exit(91);
    console.log(args.at(-1) === state.other ? "running" : state.status);
  }
  else console.log([state.status, state.image, state.mode === "bad-mount" ? "bind" : "volume", "medbox-staging_staging_private_uploads", "true"].join("|"));
} else if (args[0] === "ps") {
  if (state.mode === "ps-fail") process.exit(92);
  console.log(state.api + (state.mode === "other-writer" ? "\n" + state.other : ""));
} else if (args.includes("exec") && args.includes("db")) {
  if (state.mode === "dump-fail") { process.stdout.write("partial"); process.exit(7); }
  if (state.mode === "empty-dump") process.exit(0);
  process.stdout.write(JSON.stringify({ activePhotoKeys: [state.photoKey] }));
  // Reproduce the original live-delete interleaving if the application runs.
  if (state.status === "running") fs.unlinkSync(path.join(root, "photos", state.photoKey));
  if (state.mode === "restart-after-dump") state.status = "running";
  if (state.mode === "replace-after-dump") state.api = state.other;
  save();
} else if (args.includes("exec") && args.includes("api")) {
  // Only the old implementation reaches this branch.
  const result = spawnSync("tar", ["-czf", "-", "-C", path.join(root, "photos"), "."], { stdio: ["ignore", "inherit", "inherit"] });
  process.exit(result.status ?? 96);
} else if (args[0] === "run") {
  const expected = ["run", "--pull=never", "--rm", "--network", "none", "--read-only", "--mount",
    "type=volume,src=medbox-staging_staging_private_uploads,dst=/backup-photos,readonly",
    "--entrypoint", "tar", state.image, "-czf", "-", "-C", "/backup-photos", "."];
  if (JSON.stringify(args) !== JSON.stringify(expected)) reject();
  if (state.mode === "signal") { process.kill(process.ppid, "SIGTERM"); process.exit(0); }
  if (state.mode === "tar-fail") { process.stdout.write("partial"); process.exit(8); }
  if (state.mode === "empty-tar") process.exit(0);
  const result = spawnSync("tar", ["-czf", "-", "-C", path.join(root, "photos"), "."], { stdio: ["ignore", "inherit", "inherit"] });
  if (state.mode === "restart-after-tar") state.status = "running";
  if (state.mode === "collision") {
    const occupied = path.join(root, "backups", "medbox-20261003T000000Z-" + process.ppid);
    fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, "keep.txt"), "CONCURRENT_BACKUP");
  }
  save(); process.exit(result.status ?? 96);
} else reject();
`;

async function fixture(mode, { legacy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "medbox-backup-contract-"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "photos", dirname(photoKey)), { recursive: true });
  await writeFile(join(root, "photos", photoKey), "SYNTHETIC_PHOTO_BYTES");
  await writeFile(join(root, "synthetic.env"), "# Synthetic adapter only; no server credentials\n");
  await writeFile(join(root, "state.json"), JSON.stringify({ mode, api, other, image, photoKey, legacy,
    status: mode === "running" ? "running" : mode === "paused" ? "paused" : "exited" }));
  await writeFile(join(root, "calls.jsonl"), "");
  for (const name of ["docker", "docker-compose"]) {
    await writeFile(join(root, "bin", name), dockerAdapter);
    await chmod(join(root, "bin", name), 0o700);
  }
  for (const [name, text] of mode === "checksum-fail" ? [["sha256sum", "exit 9"]]
    : mode === "rename-fail" ? [["mv", "exit 10"]]
      : mode === "collision" ? [["date", "printf '%s\\n' 20261003T000000Z"]] : []) {
    await writeFile(join(root, "bin", name), `#!/usr/bin/env bash\n${text}\n`);
    await chmod(join(root, "bin", name), 0o700);
  }
  await mkdir(join(root, "backups", "prior-backup"), { recursive: true });
  await writeFile(join(root, "backups", "prior-backup", "keep.txt"), "PREEXISTING_BACKUP");
  const result = spawnSync("bash", [script, join(root, "synthetic.env"), join(root, "backups")], {
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, MEDBOX_BACKUP_FIXTURE: root },
    encoding: "utf8", timeout: 15000,
  });
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  return { root, result, calls };
}

function assertCompleted(result) {
  assert.equal(result.error, undefined, "Adapter timeout/spawn failure is not a product result");
  assert.equal(result.signal, null, "Harness-killed process is not a product result");
  assert.equal(typeof result.status, "number");
}

test("adapter timeout and spawn failure cannot qualify as fail-closed results", () => {
  assert.throws(() => assertCompleted({ error: new Error("ETIMEDOUT"), signal: null, status: 143 }));
  assert.throws(() => assertCompleted({ error: undefined, signal: "SIGTERM", status: null }));
  assert.throws(() => assertCompleted({ error: new Error("ENOENT"), signal: null, status: null }));
});

for (const legacy of [false, true]) test(`stopped API produces one complete backup set (${legacy ? "standalone" : "plugin"} Compose)`, linuxOnly, async () => {
  const { root, result, calls } = await fixture("stopped", { legacy });
  try {
    assertCompleted(result);
    assert.equal(result.status, 0, result.stderr);
    const entries = await readdir(join(root, "backups"));
    const output = entries.filter((name) => name !== "prior-backup");
    assert.equal(output.length, 1);
    assert.match(output[0], /^medbox-/);
    const directory = join(root, "backups", output[0]);
    assert.deepEqual((await readdir(directory)).sort(), ["SHA256SUMS", "database.dump", "photos.tar.gz"]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const name of ["SHA256SUMS", "database.dump", "photos.tar.gz"]) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    assert.equal(spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: directory }).status, 0);
    const dump = JSON.parse(await readFile(join(directory, "database.dump"), "utf8"));
    const archive = spawnSync("tar", ["-tzf", join(directory, "photos.tar.gz")], { encoding: "utf8" });
    assert.equal(archive.status, 0);
    for (const key of dump.activePhotoKeys) assert.ok(archive.stdout.split("\n").includes(`./${key}`), `Missing active photo ${key}`);
    assert.equal(await readFile(join(root, "backups", "prior-backup", "keep.txt"), "utf8"), "PREEXISTING_BACKUP");
    assert.equal(calls.filter((args) => args[0] === "run").length, 1);
    assert.ok(!calls.some((args) => args.includes("start") || args.includes("stop") || args.includes("up") || args.includes("down")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["running", "paused", "missing", "multiple", "stale", "bad-mount", "other-writer", "ps-fail", "compose-ps-fail", "consumer-inspect-fail",
  "restart-after-dump", "replace-after-dump", "restart-after-tar", "dump-fail", "empty-dump", "tar-fail", "empty-tar", "signal",
  "checksum-fail", "rename-fail", "collision"]) {
  test(`backup fails closed and preserves prior files: ${mode}`, linuxOnly, async () => {
    const { root, result, calls } = await fixture(mode);
    try {
      assertCompleted(result);
      assert.notEqual(result.status, 0, "Unsafe or incomplete backup must fail");
      const remaining = await readdir(join(root, "backups"));
      if (mode === "collision") {
        const occupied = remaining.filter((name) => name !== "prior-backup");
        assert.equal(occupied.length, 1);
        assert.match(occupied[0], /^medbox-20261003T000000Z-/);
        assert.equal(await readFile(join(root, "backups", occupied[0], "keep.txt"), "utf8"), "CONCURRENT_BACKUP");
        assert.deepEqual(await readdir(join(root, "backups", occupied[0])), ["keep.txt"]);
      } else assert.deepEqual(remaining, ["prior-backup"], result.stderr);
      assert.equal(await readFile(join(root, "backups", "prior-backup", "keep.txt"), "utf8"), "PREEXISTING_BACKUP");
      assert.ok(!result.stdout.includes("backup created"));
      assert.ok(!calls.some((args) => args.includes("start") || args.includes("stop") || args.includes("up") || args.includes("down")));
      if (["running", "paused", "missing", "multiple", "stale", "bad-mount", "other-writer", "ps-fail", "compose-ps-fail", "consumer-inspect-fail"].includes(mode)) {
        assert.ok(!calls.some((args) => args.includes("exec") || args[0] === "run"));
      }
      if (mode === "signal") assert.equal(result.status, 143);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

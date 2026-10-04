import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { exitedWithFailure, isolatedEnvironment, OwnedResources, requireHostedCI } from "./test-staging-backup-docker.mjs";

const ownerLabel = "io.medbox.backup-ci";
const token = "synthetic-test-run";
const hosted = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux" };

function fakeDocker() {
  const state = new Map();
  const calls = [];
  let counter = 0;
  let failAfterCreate = false;
  let blockedVolume;
  const add = (kind, name, owner = token) => {
    const identity = {
      name: kind === "container" ? `/${name}` : name,
      labels: { [ownerLabel]: owner },
      ...(kind === "volume" ? { created: "2026-01-01T00:00:00Z", mountpoint: `/synthetic/${name}`, driver: "local" }
        : { id: (++counter).toString(16).padStart(64, "0") }),
    };
    state.set(`${kind}:${name}`, identity);
    return identity;
  };
  const docker = async (args) => {
    calls.push([...args]);
    const [kind, operation] = args;
    if (operation === "ls") {
      const owned = args.includes("--filter");
      const names = [...state.entries()].filter(([key, value]) => key.startsWith(`${kind}:`) && (!owned || value.labels[ownerLabel] === token))
        .map(([key]) => key.slice(kind.length + 1));
      return { stdout: names.join("\n") };
    }
    if (operation === "inspect") {
      const identity = state.get(`${kind}:${args.at(-1)}`);
      if (!identity) throw new Error("missing resource");
      return { stdout: JSON.stringify(identity) };
    }
    if (operation === "create") {
      const identity = add(kind, args.at(-1));
      if (failAfterCreate) throw new Error("simulated failure after resource creation");
      return { stdout: identity.id ?? identity.name };
    }
    if (operation === "rm") {
      if (kind === "volume" && args.at(-1) === blockedVolume) throw new Error("volume is in use by an unrecorded consumer");
      const key = [...state.keys()].find((key) => key.startsWith(`${kind}:`)
        && (state.get(key).id ?? state.get(key).name) === args.at(-1));
      assert(key, "Deletion must use the recorded ID or volume name");
      state.delete(key);
      return { stdout: "" };
    }
    throw new Error(`Unexpected fake command: ${args.join(" ")}`);
  };
  return { docker, add, calls, state, failCreation: () => { failAfterCreate = true; },
    blockVolume: (name) => { blockedVolume = name; } };
}

test("runtime rejects local, self-hosted, and non-Linux use", () => {
  assert.doesNotThrow(() => requireHostedCI(hosted));
  for (const key of Object.keys(hosted)) assert.throws(() => requireHostedCI({ ...hosted, [key]: undefined }));
  assert.throws(() => requireHostedCI({ ...hosted, RUNNER_ENVIRONMENT: "self-hosted" }));
  assert.throws(() => requireHostedCI({ ...hosted, RUNNER_OS: "Windows" }));
});

test("subprocess environment is an allowlist with local Docker and no inherited secrets", () => {
  const env = isolatedEnvironment("/tools", "/synthetic", "unique-project");
  assert.deepEqual(env, {
    PATH: "/tools", DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: join("/synthetic", "docker-config"),
    COMPOSE_PROJECT_NAME: "unique-project", COMPOSE_DISABLE_ENV_FILE: "1",
  });
  for (const key of ["HOME", "PGHOST", "PGPASSWORD", "DATABASE_URL", "WECHAT_APP_SECRET", "DASHSCOPE_API_KEY", "DOCKER_CONTEXT", "COMPOSE_FILE"])
    assert.equal(env[key], undefined);
});

test("timeouts, signals and failed spawns cannot qualify as expected backup failures", () => {
  assert.equal(exitedWithFailure({ cause: { code: 1, killed: false, signal: null } }), true);
  for (const cause of [{ code: 0 }, { code: "ENOENT" }, { code: 1, killed: true }, { code: null, signal: "SIGKILL" }])
    assert.equal(exitedWithFailure({ cause }), false);
});

test("preexisting names are never adopted, changed, or removed, even with matching labels", async () => {
  for (const kind of ["container", "volume", "network"]) {
    const fake = fakeDocker();
    const original = fake.add(kind, "already-exists");
    const resources = new OwnedResources(fake.docker, token);
    await assert.rejects(resources.create(kind, "already-exists", [kind, "create", "already-exists"]), /preexisting/);
    await resources.cleanup();
    assert.equal(fake.state.get(`${kind}:already-exists`), original);
    assert(!fake.calls.some((args) => ["create", "rm"].includes(args[1])));
  }
});

test("cleanup removes only recorded identities in reverse acquisition order", async () => {
  const fake = fakeDocker();
  const foreign = fake.add("container", "unrelated", "someone-else");
  const resources = new OwnedResources(fake.docker, token);
  await resources.create("network", "network", ["network", "create", "network"]);
  await resources.create("volume", "volume", ["volume", "create", "volume"]);
  const id = await resources.create("container", "container", ["container", "create", "container"]);
  await resources.cleanup();
  await resources.assertEmpty();
  assert.equal(fake.state.size, 1);
  assert.equal(fake.state.get("container:unrelated"), foreign);
  assert.deepEqual(fake.calls.filter((args) => args[1] === "rm").map((args) => args[0]), ["container", "volume", "network"]);
  assert.deepEqual(fake.calls.find((args) => args[0] === "container" && args[1] === "rm"), ["container", "rm", "--force", id]);
});

test("a partial create failure records its uniquely owned resource for cleanup", async () => {
  const fake = fakeDocker();
  const resources = new OwnedResources(fake.docker, token);
  fake.failCreation();
  await assert.rejects(resources.create("container", "partial", ["container", "create", "partial"]), /simulated failure/);
  assert.equal(resources.records.length, 1);
  await resources.cleanup();
  assert.equal(fake.state.size, 0);
});

test("changed container identity or ownership is retained, while other owned resources are cleaned", async () => {
  for (const change of ["id", "owner"]) {
    const fake = fakeDocker();
    const resources = new OwnedResources(fake.docker, token);
    await resources.create("container", "unchanged", ["container", "create", "unchanged"]);
    await resources.create("container", "changed", ["container", "create", "changed"]);
    const identity = fake.state.get("container:changed");
    if (change === "id") identity.id = "f".repeat(64);
    else identity.labels[ownerLabel] = "foreign-owner";
    await assert.rejects(resources.cleanup(), /cleanup failed/);
    assert.deepEqual([...fake.state.keys()], ["container:changed"]);
    assert.equal(fake.calls.filter((args) => args[1] === "rm").length, 1);
  }
});

test("replaced volume creation fingerprint prevents deletion", async () => {
  const fake = fakeDocker();
  const resources = new OwnedResources(fake.docker, token);
  await resources.create("volume", "replaced", ["volume", "create", "replaced"]);
  fake.state.get("volume:replaced").created = "2026-01-02T00:00:00Z";
  await assert.rejects(resources.cleanup(), /cleanup failed/);
  assert(!fake.calls.some((args) => args[1] === "rm"));
});

test("in-use volume cleanup reports failure and retains the unknown consumer", async () => {
  const fake = fakeDocker();
  const resources = new OwnedResources(fake.docker, token);
  await resources.create("volume", "photos", ["volume", "create", "photos"]);
  const owned = await resources.create("container", "owned-helper", ["container", "create", "owned-helper"]);
  const unknown = fake.add("container", "unknown-reader", "unrecorded");
  fake.blockVolume("photos");
  await assert.rejects(resources.cleanup(), (error) => {
    assert.match(error.message, /cleanup failed/);
    assert.match(error.errors[0].message, /volume is in use/);
    return true;
  });
  assert.equal(fake.state.get("container:unknown-reader"), unknown);
  assert(fake.state.has("volume:photos"));
  assert.deepEqual(fake.calls.filter((args) => args[1] === "rm"), [
    ["container", "rm", "--force", owned], ["volume", "rm", "photos"],
  ]);
  assert.deepEqual(resources.records.map((r) => r.name), ["photos"]);
});

test("foreign ownership cannot be captured; unrecorded owned resources fail the final check", async () => {
  const fake = fakeDocker();
  fake.add("container", "foreign", "another-run");
  fake.add("volume", "unrecorded");
  const resources = new OwnedResources(fake.docker, token);
  await assert.rejects(resources.capture("container", "foreign"), /Ownership mismatch/);
  assert.equal(resources.records.length, 0);
  await assert.rejects(resources.assertEmpty(), /Unrecorded or retained owned volume/);
  assert(!fake.calls.some((args) => args[1] === "rm"));
});

test("a Docker listing failure is not treated as proof that a name is absent", async () => {
  const calls = [];
  const resources = new OwnedResources(async (args) => { calls.push(args); throw new Error("daemon unavailable"); }, token);
  await assert.rejects(resources.create("volume", "unsafe", ["volume", "create", "unsafe"]), /daemon unavailable/);
  assert.deepEqual(calls.map((args) => args[1]), ["ls"]);
});

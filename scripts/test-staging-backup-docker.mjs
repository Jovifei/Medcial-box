// CI-only synthetic transport check. This is not a staging restore command.
// No API server, provider request, host port, production data, or saved credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ownerLabel = "io.medbox.backup-ci";
const uploadRoot = "/var/lib/medbox/private-uploads";
const database = "medbox_backup_ci";
const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  family: "22222222-2222-4222-8222-222222222222",
  medicine: "33333333-3333-4333-8333-333333333333",
  photo: "44444444-4444-4444-8444-444444444444",
};
const photoBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaDjwHwAEhAJgikCezQAAAABJRU5ErkJggg==";
const photoKey = `leaflets/${ids.family}/${ids.medicine}/${ids.photo}.png`;

export function requireHostedCI(env) {
  assert.equal(env.CI, "true", "This destructive synthetic exercise is CI-only");
  assert.equal(env.GITHUB_ACTIONS, "true", "GitHub Actions is required");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "Use a disposable GitHub-hosted runner");
  assert.equal(env.RUNNER_OS, "Linux", "The exercise requires Linux Docker");
}

export function isolatedEnvironment(path, scratch, project) {
  // Deliberate allowlist: no ambient PG*, DATABASE_URL, provider secrets,
  // COMPOSE_FILE, remote Docker context, proxy, or saved Docker credentials.
  return {
    PATH: path,
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: join(scratch, "docker-config"),
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_DISABLE_ENV_FILE: "1",
  };
}

export function exitedWithFailure(error) {
  const cause = error.cause;
  return Number.isInteger(cause?.code) && cause.code > 0 && !cause.killed && !cause.signal;
}

// A volume has no immutable Docker ID. Record its name, creation time,
// mountpoint, driver, and unique run label; fail closed if any changes.
const inspectFormats = {
  container: '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}}}',
  network: '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}}}',
  volume: '{"name":{{json .Name}},"created":{{json .CreatedAt}},"mountpoint":{{json .Mountpoint}},"driver":{{json .Driver}},"labels":{{json .Labels}}}',
};

export class OwnedResources {
  constructor(docker, token) {
    this.docker = docker;
    this.token = token;
    this.records = [];
  }

  async names(kind) {
    const args = kind === "container" ? ["--all", "--format", "{{.Names}}"] : ["--format", "{{.Name}}"];
    return (await this.docker([kind, "ls", ...args])).stdout.trim().split("\n").filter(Boolean);
  }

  async absent(kind, name) {
    assert(!(await this.names(kind)).includes(name), `Refusing preexisting ${kind}: ${name}`);
  }

  async snapshot(kind, name) {
    return JSON.parse((await this.docker([kind, "inspect", "--format", inspectFormats[kind], name])).stdout);
  }

  async capture(kind, name) {
    const identity = await this.snapshot(kind, name);
    assert.equal(identity.labels?.[ownerLabel], this.token, `Ownership mismatch: ${kind} ${name}`);
    assert.equal(identity.name.replace(/^\//, ""), name);
    if (kind !== "volume") assert.match(identity.id, /^[a-f0-9]{64}$/);
    else assert(identity.created && identity.mountpoint && identity.driver);
    this.records.push({ kind, name, identity });
    return identity.id ?? name;
  }

  async create(kind, name, args) {
    await this.absent(kind, name);
    try {
      await this.docker(args);
    } finally {
      // Even a failed create may have made a resource. Only claim it if the
      // previously absent name has this invocation's unpredictable label.
      if ((await this.names(kind)).includes(name)) await this.capture(kind, name);
    }
    return this.records.at(-1).identity.id ?? name;
  }

  async remove(record) {
    if (!(await this.names(record.kind)).includes(record.name)) {
      throw new Error(`Recorded resource disappeared: ${record.kind} ${record.name}`);
    }
    assert.deepEqual(await this.snapshot(record.kind, record.name), record.identity,
      `Refusing changed identity or ownership: ${record.kind} ${record.name}`);
    const args = record.kind === "container" ? ["--force", record.identity.id] : [record.identity.id ?? record.name];
    await this.docker([record.kind, "rm", ...args]);
    await this.absent(record.kind, record.name);
    this.records.splice(this.records.indexOf(record), 1);
  }

  async cleanup() {
    const failures = [];
    // Containers first, then their named volumes and network. No Compose down,
    // prune, wildcard removal, anonymous-volume removal, or image deletion.
    // staging-backup.sh owns its separate unlabeled --rm tar reader. Killing
    // its Docker client can leave that reader alive. An in-use volume then
    // fails cleanup and is retained; never find/delete unknown containers to
    // force success. Guard tests do not qualify real interruption recovery.
    for (const record of [...this.records].reverse()) {
      try { await this.remove(record); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Owned Docker resource cleanup failed");
  }

  async assertEmpty() {
    for (const kind of ["container", "volume", "network"]) {
      const args = kind === "container" ? ["--all"] : [];
      const remaining = (await this.docker([kind, "ls", ...args, "--quiet", "--filter", `label=${ownerLabel}=${this.token}`])).stdout.trim();
      assert.equal(remaining, "", `Unrecorded or retained owned ${kind} resources remain`);
    }
  }
}

export async function exercise() {
  requireHostedCI(process.env);
  assert.equal(process.argv.length, 2, "No stack, env-file, or resource arguments are accepted");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scratch = await mkdtemp(join(tmpdir(), "medbox-backup-ci-"));
  const project = `medbox-backup-ci-${randomUUID().replaceAll("-", "")}`;
  const env = isolatedEnvironment(process.env.PATH, scratch, project);
  await mkdir(env.DOCKER_CONFIG, { mode: 0o700 });
  let activeChild;
  let interrupted = false;
  const onSignal = () => { interrupted = true; activeChild?.kill("SIGKILL"); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const run = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
    const child = execFile(command, args, {
      cwd: options.cwd ?? root, env, timeout: options.timeout ?? 90_000,
      killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      activeChild = undefined;
      if (error) rejectRun(new Error(`${command} ${args[0]} failed: ${stderr || error.message}`, { cause: error }));
      else resolveRun({ stdout, stderr });
    });
    activeChild = child;
    child.stdin.on("error", () => {}); // A failed command can close stdin early.
    child.stdin.end(options.input);
  });
  const docker = (args, options) => run("docker", args, options);
  const resources = new OwnedResources(docker, project);
  const checkpoint = () => assert(!interrupted, "Exercise interrupted; cleaning up owned resources");
  const labelArgs = ["--label", `${ownerLabel}=${project}`];
  const volumes = Object.fromEntries(["staging_database", "staging_private_uploads", "restore_database", "restore_photos"]
    .map((key) => [key, `${project}_${key}`]));
  const network = `${project}_default`;
  const appTag = `${project}-api:latest`;
  const envFile = join(scratch, "synthetic.env");
  const overrideFile = join(scratch, "compose-ci.json");
  const compose = ["compose", "--env-file", envFile, "-f", "deploy/docker-compose.staging.yml", "-f", overrideFile];
  const syntheticPassword = `ci-only-${randomUUID()}`;
  let helperNumber = 0;
  let failure;
  try {
    assert.equal((await docker(["info", "--format", "{{.OSType}}"])).stdout.trim(), "linux");
    await docker(["compose", "version"]);
    checkpoint();
    // Explicit --env-file and the subprocess allowlist prevent .env loading and
    // environment precedence from substituting real provider/database values.
    await writeFile(envFile, [
      `COMPOSE_PROJECT_NAME=${project}`, `POSTGRES_DB=${database}`, `POSTGRES_USER=${database}`,
      `POSTGRES_PASSWORD=${syntheticPassword}`, "WECHAT_APP_ID=ci-synthetic-unused",
      "WECHAT_APP_SECRET=ci-synthetic-unused", "MEDICINE_RECOGNITION_PROVIDER=disabled",
      "DASHSCOPE_API_KEY=", "JISU_MEDICINE_API_KEY=", "WECHAT_REMINDER_SCHEDULER_ENABLED=false",
      "WECHAT_REMINDER_TEMPLATE_ID=", "STAGING_API_PORT=0", "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(overrideFile, JSON.stringify({
      services: {
        db: { container_name: `${project}-db`, restart: "no", labels: { [ownerLabel]: project } },
        api: {
          container_name: `${project}-api`, image: appTag, restart: "no", labels: { [ownerLabel]: project },
          // Never start server.js, even accidentally. Created only; no jobs or outbound calls.
          entrypoint: ["node", "-e", "process.exit(99)"], command: [], healthcheck: { disable: true },
        },
      },
      volumes: Object.fromEntries(["staging_database", "staging_private_uploads"].map((key) =>
        [key, { external: true, name: volumes[key] }])),
      networks: { default: { external: true, name: network } },
    }), { mode: 0o600 });

    assert(!(await docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).stdout.split("\n").includes(appTag),
      "Refusing preexisting application image tag");
    await docker(["build", ...labelArgs, "--tag", appTag, "--file", "apps/api/Dockerfile", "."], { timeout: 600_000 });
    const appImage = (await docker(["image", "inspect", "--format", "{{.Id}}", appTag])).stdout.trim();
    assert.match(appImage, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await docker(["image", "inspect", "--format", `{{index .Config.Labels "${ownerLabel}"}}`, appImage])).stdout.trim(), project);
    await docker(["pull", "postgres:17-alpine"], { timeout: 180_000 });
    const pgImage = (await docker(["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"])).stdout.trim();
    checkpoint();
    await resources.create("network", network, ["network", "create", "--internal", ...labelArgs, network]);
    for (const name of Object.values(volumes)) {
      await resources.create("volume", name, ["volume", "create", ...labelArgs, name]);
    }
    // Assert both absent before Compose creates either. Capture partial results
    // after a failing Compose command too, without adopting unrelated resources.
    for (const service of ["db", "api"]) await resources.absent("container", `${project}-${service}`);
    try { await docker([...compose, "create", "--no-build", "--pull", "never", "db", "api"]); }
    finally {
      const names = await resources.names("container");
      for (const service of ["db", "api"]) {
        const name = `${project}-${service}`;
        if (names.includes(name)) await resources.capture("container", name);
      }
    }
    const dbId = resources.records.find((r) => r.name === `${project}-db`).identity.id;
    const apiId = resources.records.find((r) => r.name === `${project}-api`).identity.id;
    assert.equal((await docker(["inspect", "--format", "{{.State.Status}}", apiId])).stdout.trim(), "created");
    const waitForDb = async (id) => {
      const until = Date.now() + 90_000;
      while (Date.now() < until) {
        checkpoint();
        // The official image's temporary init server accepts Unix sockets;
        // TCP readiness waits until its final server is running instead.
        try { await docker(["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", database, "-d", database], { timeout: 5_000 }); return; }
        catch { await delay(1_000); }
      }
      throw new Error("Synthetic PostgreSQL did not become ready within 90 seconds");
    };
    await docker(["start", dbId]);
    await waitForDb(dbId);

    const helper = async (args, image, command, { input, start = true } = {}) => {
      checkpoint();
      const name = `${project}-helper-${++helperNumber}`;
      const id = await resources.create("container", name, ["create", "--name", name, ...labelArgs,
        "--pull=never", "--read-only", "--interactive", ...args, image, ...command]);
      if (!start) return id;
      const result = await docker(["start", "--attach", "--interactive", id], { input });
      assert.equal((await docker(["inspect", "--format", "{{.State.ExitCode}}", id])).stdout.trim(), "0", `Helper failed: ${name}`);
      return result.stdout.trim();
    };
    const mount = (volume, readOnly = false) => ["--mount", `type=volume,src=${volume},dst=${uploadRoot}${readOnly ? ",readonly" : ""}`];
    await helper(["--network", network, "--env", "PGHOST=db", "--env", `PGDATABASE=${database}`,
      "--env", `PGUSER=${database}`, "--env", `PGPASSWORD=${syntheticPassword}`, "--entrypoint", "node"],
    appImage, ["apps/api/dist/migrate.js"]);
    const storedKey = await helper(["--network", "none", ...mount(volumes.staging_private_uploads), "--entrypoint", "node"], appImage,
      ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { stat } from 'node:fs/promises';
        import { PrivatePhotoStore } from './apps/api/dist/services/private-photo-store.js';
        const key = await new PrivatePhotoStore().save({familyId:'${ids.family}',medicineId:'${ids.medicine}',photoId:'${ids.photo}',contentType:'image/png',bytes:Buffer.from('${photoBase64}','base64')});
        const file = await stat('${uploadRoot}/' + key);
        assert(process.getuid() > 0); assert.equal(file.uid, process.getuid()); assert.equal(file.mode & 0o777, 0o600);
        console.log(key);
      `]);
    assert.equal(storedKey, photoKey);
    const sql = (id, text) => docker(["exec", "-i", id, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", database, "-d", database, "-At"], { input: text });
    await sql(dbId, `
      BEGIN;
      INSERT INTO users(id,openid) VALUES('${ids.user}','ci-synthetic-user');
      INSERT INTO families(id,name,created_by) VALUES('${ids.family}','CI synthetic family','${ids.user}');
      INSERT INTO family_members(family_id,user_id,role) VALUES('${ids.family}','${ids.user}','owner');
      INSERT INTO medicines(id,family_id,name,created_by,updated_by) VALUES('${ids.medicine}','${ids.family}','CI synthetic medicine','${ids.user}','${ids.user}');
      INSERT INTO medicine_leaflet_photos(id,family_id,medicine_id,storage_key,content_type,size_bytes,created_by,purpose,upload_completed_at)
        VALUES('${ids.photo}','${ids.family}','${ids.medicine}','${photoKey}','image/png',${Buffer.from(photoBase64, "base64").length},'${ids.user}','box_front',now());
      UPDATE medicines SET cover_photo_id='${ids.photo}' WHERE id='${ids.medicine}';
      COMMIT;
    `);
    const migrationsSql = "SELECT json_agg(t ORDER BY name) FROM (SELECT name,checksum FROM schema_migrations) t;";
    const migrations = JSON.parse((await sql(dbId, migrationsSql)).stdout);
    assert.equal(migrations.length, (await readdir(join(root, "apps/api/db/migrations"))).filter((name) => /^\d+_.*\.sql$/.test(name)).length);
    assert(migrations.length > 0);

    const backup = async (name, expectedError) => {
      checkpoint();
      const directory = join(scratch, name);
      await mkdir(directory);
      if (expectedError) {
        await assert.rejects(run("bash", ["scripts/staging-backup.sh", envFile, directory]), (error) => {
          assert(exitedWithFailure(error), "Timeout, signal, or spawn error cannot qualify a failure-path check");
          assert.match(error.message, expectedError);
          return true;
        });
        assert.deepEqual(await readdir(directory), [], "Failed backup left a partial or published directory");
      } else {
        await run("bash", ["scripts/staging-backup.sh", envFile, directory]);
        const entries = await readdir(directory);
        assert.equal(entries.length, 1);
        assert.match(entries[0], /^medbox-\d{8}T\d{6}Z-\d+$/);
        const result = join(directory, entries[0]);
        assert.deepEqual((await readdir(result)).sort(), ["SHA256SUMS", "database.dump", "photos.tar.gz"]);
        await run("sha256sum", ["-c", "SHA256SUMS"], { cwd: result });
        return result;
      }
    };
    const writer = await helper(["--network", "none", ...mount(volumes.staging_private_uploads), "--entrypoint", "node"], appImage,
      ["-e", "setTimeout(() => {}, 300000)"], { start: false });
    await docker(["start", writer]);
    assert.equal((await docker(["inspect", "--format", "{{.State.Status}}", writer])).stdout.trim(), "running");
    await backup("active-consumer", /photo-volume consumer is active/);
    await resources.remove(resources.records.find((r) => r.identity.id === writer));
    await docker(["stop", "--time", "10", dbId]);
    assert.equal((await docker(["inspect", "--format", "{{.State.Status}}", dbId])).stdout.trim(), "exited");
    await backup("stopped-db", /not running/);
    await docker(["start", dbId]);
    await waitForDb(dbId);
    await helper(["--network", "none", "--user", "0:0", ...mount(volumes.staging_private_uploads), "--entrypoint", "node"], appImage,
      ["-e", `require('node:fs').writeFileSync('${uploadRoot}/unreadable-ci-fixture', 'synthetic', {mode:0o000})`]);
    await backup("unreadable-photo", /Permission denied|permission denied/);
    await helper(["--network", "none", "--user", "0:0", ...mount(volumes.staging_private_uploads), "--entrypoint", "node"], appImage,
      ["-e", `require('node:fs').unlinkSync('${uploadRoot}/unreadable-ci-fixture')`]);
    const complete = await backup("complete");
    console.log("PASS: active consumer, stopped DB, unreadable photo, failed-output cleanup, complete backup + checksums");

    const restoreName = `${project}-restore`;
    const restoreId = await resources.create("container", restoreName, ["create", "--name", restoreName, ...labelArgs,
      "--pull=never", "--network", "none", "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_USER=${database}`,
      "--env", `POSTGRES_PASSWORD=${syntheticPassword}`, "--mount", `type=volume,src=${volumes.restore_database},dst=/var/lib/postgresql/data`, pgImage]);
    await docker(["start", restoreId]);
    await waitForDb(restoreId);
    await docker(["exec", "-i", restoreId, "pg_restore", "--exit-on-error", "-U", database, "-d", database],
      { input: await readFile(join(complete, "database.dump")) });
    assert.deepEqual(JSON.parse((await sql(restoreId, migrationsSql)).stdout), migrations);
    const query = `SELECT row_to_json(t) FROM (SELECT m.name,p.storage_key,p.content_type,p.size_bytes,p.purpose,p.family_id,p.medicine_id,m.cover_photo_id
      FROM medicines m JOIN medicine_leaflet_photos p ON p.id=m.cover_photo_id AND p.medicine_id=m.id AND p.family_id=m.family_id
      WHERE m.id='${ids.medicine}' AND p.deleted_at IS NULL AND p.storage_removed_at IS NULL AND p.upload_completed_at IS NOT NULL) t;`;
    const metadata = JSON.parse((await sql(restoreId, query)).stdout);
    assert.deepEqual(metadata, { name: "CI synthetic medicine", storage_key: photoKey, content_type: "image/png",
      size_bytes: Buffer.from(photoBase64, "base64").length, purpose: "box_front", family_id: ids.family,
      medicine_id: ids.medicine, cover_photo_id: ids.photo });
    await helper(["--network", "none", ...mount(volumes.restore_photos), "--entrypoint", "tar"], appImage,
      ["-xzf", "-", "-C", uploadRoot], { input: await readFile(join(complete, "photos.tar.gz")) });
    await helper(["--network", "none", ...mount(volumes.restore_photos, true), "--entrypoint", "node"], appImage,
      ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { stat } from 'node:fs/promises';
        import { PrivatePhotoStore } from './apps/api/dist/services/private-photo-store.js';
        const key = ${JSON.stringify(metadata.storage_key)};
        const bytes = await new PrivatePhotoStore().read(key);
        assert(bytes.equals(Buffer.from('${photoBase64}', 'base64')));
        const file = await stat('${uploadRoot}/' + key);
        assert(process.getuid() > 0); assert.equal(file.uid, process.getuid()); assert.equal(file.mode & 0o777, 0o600);
      `]);
    checkpoint();
    assert.equal((await docker(["inspect", "--format", "{{.State.Status}}", apiId])).stdout.trim(), "created");
    console.log(`PASS: ${migrations.length} actual migrations, restored medicine/photo association, exact PNG bytes, non-root owner + mode0600`);
    console.log(`Synthetic images: app=${appImage} postgres=${pgImage}; API server was never started`);
  } catch (error) { failure = error; }
  finally {
    try {
      await resources.cleanup();
      assert.equal(resources.records.length, 0);
      await resources.assertEmpty();
      console.log("PASS: recorded containers, named volumes, and internal network removed by verified identity");
      // Only this process's freshly created host directory. Images/build cache
      // remain on the disposable runner; never delete a possibly shared image.
      await rm(scratch, { recursive: true });
    } catch (error) { failure = new AggregateError([failure, error].filter(Boolean), `Cleanup incomplete; synthetic files retained at ${scratch}`); }
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  if (failure) throw failure;
  console.log("Synthetic CI transport qualified only; production restore permissions, operator exclusivity, and disaster recovery remain unverified");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exercise().catch((error) => { console.error(error); process.exitCode = 1; });
}

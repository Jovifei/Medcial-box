// GitHub-hosted CI only: all databases, photos, images and containers are synthetic.
// This exercises the production guard; it accepts no production files or targets.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {OwnedResources, requireHostedCI, isolatedEnvironment, exitedWithFailure} from './test-staging-backup-docker.mjs';
import {buildApiCandidate, digest} from './build-api-candidate.mjs';
import {discoverBinding, preflight, applyCandidate} from './deployment-guard.mjs';

export async function exerciseDeploymentGuard() {
  requireHostedCI(process.env);
  assert.equal(process.argv.length, 2, 'No stack, credentials or resource arguments accepted');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = await mkdtemp(join(tmpdir(), 'medbox-guard-ci-'));
  const project = `medbox-guard-ci-${randomUUID().replaceAll('-', '')}`;
  const env = isolatedEnvironment(process.env.PATH, scratch, project);
  await mkdir(env.DOCKER_CONFIG, {mode: 0o700});
  let child, interrupted = false;
  const stop = () => { interrupted = true; child?.kill('SIGKILL'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const run = (program, args, options = {}) => new Promise((yes, no) => {
    assert(!interrupted, 'Synthetic exercise interrupted');
    child = execFile(program, args, {cwd: options.cwd ?? root, env, encoding: 'utf8',
      timeout: options.timeout ?? 90_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
      child = undefined;
      if (error) no(new Error(`${program} ${args[0]} failed: ${stderr || error.message}`, {cause: error}));
      else yes({stdout});
    });
    child.stdin.on('error', () => {}); child.stdin.end(options.input);
  });
  const calls = [];
  const docker = async (args, options) => { calls.push(args); return run('docker', ['--host', env.DOCKER_HOST, ...args], options); };
  const resources = new OwnedResources(docker, project), ownerLabel = 'io.medbox.backup-ci';
  const labels = ['--label', `${ownerLabel}=${project}`];
  const database = 'medbox_guard_ci', password = "#'synthetic-" + randomUUID() + "-$ONE-$$TWO-${THREE}'";
  const composePassword = password.replaceAll('$', () => '$$');
  const uploadRoot = '/var/lib/medbox/private-uploads';
  const volumes = {database: `${project}_database`, photos: `${project}_photos`, empty: `${project}_empty`};
  const network = `${project}_default`, configFile = join(scratch, 'compose.json'), envFile = join(scratch, 'empty.env');
  const checks = [], artifactDir = join(root, 'var/deployment-guard');
  let failure, source, binding, pgImage, helperNumber = 0;
  const forbidden = args => ['run', 'create', 'start', 'stop', 'rm', 'build', 'pull', 'connect', 'disconnect'].some(action => args[0] === action || args[1] === action) || args.includes('up') || args.includes('down');
  const negative = async (name, operation, pattern) => {
    const start = calls.length;
    await assert.rejects(operation, error => {
      assert.equal(error.name, 'Error', 'Runtime/programming errors are not expected guard rejections');
      if (error.cause) assert(exitedWithFailure(error), 'Timeout/signal/spawn failure is not a fail-closed result');
      assert(pattern instanceof RegExp, 'Every negative case requires its specific diagnostic');
      assert.match(error.message, pattern);
      return true;
    });
    assert(!calls.slice(start).some(forbidden), `${name}: preflight must not mutate Docker resources`);
    checks.push({name, status: 'PASS', effect: 'REJECTED_BEFORE_DOCKER_MUTATION'});
  };
  try {
    assert.equal((await docker(['info', '--format', '{{.OSType}}'])).stdout.trim(), 'linux');
    await docker(['compose', 'version']);
    const sha = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
    const candidateTag = `${project}:candidate`;
    source = await buildApiCandidate({root, sha, tag: candidateTag, apiOrigin: 'https://synthetic.invalid',
      output: join(scratch, 'candidate.json'), docker: (args, options) => docker(args, {...options, timeout: 600_000})});
    assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}}', candidateTag])).stdout.trim(), source.imageId);
    await mkdir(join(scratch, 'old-image'));
    // BuildKit accepts the fresh local tag as FROM; a config image ID is not a
    // registry reference. Bind the tag on both sides of this synthetic build.
    await writeFile(join(scratch, 'old-image/Dockerfile'), `FROM ${candidateTag}\nLABEL org.opencontainers.image.revision="" io.medbox.source-tree="" io.medbox.api-tree=""\n`);
    await docker(['build', '--tag', `${project}:old`, join(scratch, 'old-image')], {timeout: 180_000});
    assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}}', candidateTag])).stdout.trim(), source.imageId);
    const oldImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', `${project}:old`])).stdout.trim();
    assert.notEqual(oldImage, source.imageId);
    await docker(['pull', 'postgres:17-alpine'], {timeout: 180_000});
    pgImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:17-alpine'])).stdout.trim();
    await resources.create('network', network, ['network', 'create', '--internal', ...labels, network]);
    for (const name of Object.values(volumes)) await resources.create('volume', name, ['volume', 'create', ...labels, name]);
    const config = {name: project, services: {
      db: {image: pgImage, container_name: `${project}-db`, labels: {[ownerLabel]: project}, restart: 'no', command: ['postgres', '-p', '5432'],
        environment: {POSTGRES_DB: database, POSTGRES_USER: database, POSTGRES_PASSWORD: composePassword,
          // Production DB probes/dumps must sanitize these inherited libpq overrides.
          PGHOST: 'wrong-db.invalid', PGPORT: '6543', PGOPTIONS: '-c search_path=wrong_schema'},
        volumes: [{type: 'volume', source: 'database', target: '/var/lib/postgresql/data'}], networks: {default: {aliases: ['db']}}},
      api: {image: oldImage, container_name: `${project}-api`, labels: {[ownerLabel]: project, literal: 'synthetic-$$literal'}, restart: 'no', init: true,
        environment: {NODE_ENV: 'production', API_HOST: '0.0.0.0', API_PORT: '3000',
          PGHOST: 'db', PGPORT: '5432', PGDATABASE: database, PGUSER: database, PGPASSWORD: composePassword,
          PRIVATE_UPLOAD_DIR: uploadRoot, WECHAT_APP_ID: 'synthetic-unused', WECHAT_APP_SECRET: 'synthetic-unused',
          MEDICINE_RECOGNITION_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: '', JISU_MEDICINE_API_KEY: '',
          WECHAT_REMINDER_SCHEDULER_ENABLED: 'false', WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED: 'false', LEAFLET_PHOTO_CLEANUP_ENABLED: 'false'},
        volumes: [{type: 'volume', source: 'photos', target: uploadRoot}], networks: {default: null}},
    }, volumes: Object.fromEntries(['database', 'photos'].map(key => [key, {external: true, name: volumes[key]}])),
    networks: {default: {external: true, name: network}}};
    await writeFile(configFile, JSON.stringify(config), {mode: 0o600}); await writeFile(envFile, '', {mode: 0o600});
    const compose = ['compose', '--project-name', project, '--env-file', envFile, '-f', configFile];
    for (const service of ['db', 'api']) await resources.absent('container', `${project}-${service}`);
    try { await docker([...compose, 'create', '--no-build', '--pull', 'never', 'db', 'api']); }
    finally {
      for (const name of await resources.names('container')) if (name === `${project}-db` || name === `${project}-api`) await resources.capture('container', name);
    }
    const apiId = resources.records.find(record => record.name === `${project}-api`).identity.id;
    const dbId = resources.records.find(record => record.name === `${project}-db`).identity.id;
    const waitForDb = async id => {
      const until = Date.now() + 90_000;
      while (Date.now() < until) {
        try { await docker(['exec', id, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', database, '-d', database], {timeout: 5000}); return; }
        catch (error) { if (interrupted || !exitedWithFailure(error)) throw error; await delay(1000); }
      }
      throw new Error('Synthetic DB readiness timeout');
    };
    await docker(['start', dbId]); await waitForDb(dbId);
    const helper = async (args, command) => {
      const name = `${project}-helper-${++helperNumber}`;
      const id = await resources.create('container', name, ['create', '--name', name, ...labels,
        '--pull=never', '--read-only', ...args, '--entrypoint', 'node', source.imageId, ...command]);
      const result = await docker(['start', '--attach', id]);
      assert.equal((await docker(['inspect', '--format', '{{.State.ExitCode}}', id])).stdout.trim(), '0');
      await resources.remove(resources.records.find(record => record.identity.id === id));
      return result.stdout.trim();
    };
    // Only fixture initialization uses migrations; the production guard never does.
    await helper(['--network', network, '--env', 'PGHOST=db', '--env', 'PGPORT=5432', '--env', `PGUSER=${database}`,
      '--env', `PGDATABASE=${database}`, '--env', `PGPASSWORD=${password}`], ['apps/api/dist/migrate.js']);
    const sql = text => docker(['exec', dbId, 'sh', '-c',
      'exec env -i PATH="$PATH" PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"', 'sh', text]);
    await sql("INSERT INTO users(id,openid) VALUES('11111111-1111-4111-8111-111111111111','synthetic-a'),('22222222-2222-4222-8222-222222222222','synthetic-b'); INSERT INTO families(id,name,created_by) VALUES('33333333-3333-4333-8333-333333333333','Synthetic A','11111111-1111-4111-8111-111111111111'),('44444444-4444-4444-8444-444444444444','Synthetic B','22222222-2222-4222-8222-222222222222');");
    await helper(['--network', 'none', '--mount', `type=volume,src=${volumes.photos},dst=${uploadRoot}`],
      ['-e', `require('node:fs').writeFileSync('${uploadRoot}/synthetic-photo.txt','SYNTHETIC_PHOTO_ONLY',{mode:0o600})`]);
    const photoDigest = () => helper(['--network', 'none', '--mount', `type=volume,src=${volumes.photos},dst=${uploadRoot},readonly`],
      ['-e', `console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${uploadRoot}/synthetic-photo.txt')).digest('hex'))`]);
    const snapshotSql = "SELECT json_build_object('users',(SELECT json_agg(t ORDER BY id) FROM users t),'families',(SELECT json_agg(t ORDER BY id) FROM families t));";
    const before = (await sql(snapshotSql)).stdout.trim(), beforePhoto = await photoDigest();
    binding = await discoverBinding({endpoint: env.DOCKER_HOST, project, files: [configFile], envFile, apiOrigin: source.apiOrigin, docker});
    await negative('unreviewed discovery cannot authorize', () => preflight({binding, candidate: source, docker}), /independently reviewed/);
    assert.equal(binding.api.id, apiId); assert.equal(binding.db.id, dbId);
    assert.equal(binding.volumes.database.name, volumes.database); assert.equal(binding.volumes.photos.name, volumes.photos);
    binding.review = {status: 'OWNER_REVIEWED', reference: 'CI-only identities checked against this invocation creation ledger and initialization'};
    await preflight({binding, candidate: source, docker});
    checks.push({name: 'existing unlabeled image plus labeled candidate preflight', status: 'PASS'});
    for (const [name, change, pattern] of [
      ['wrong Compose project', b => { b.project = `${project}-wrong`; }, /Resolved Compose configuration identity mismatch/],
      ['reviewed volume name mismatch', b => { b.volumes.database.name = `${project}_missing`; }, /Candidate service selects another volume/],
      ['reviewed volume creation fingerprint mismatch', b => { b.volumes.photos.created = '2000-01-01T00:00:00Z'; }, /photos volume identity mismatch/],
      ['wrong database OID', b => { b.database.oid = '1'; }, /Database identity mismatch/],
      ['wrong instance system identifier', b => { b.database.systemIdentifier = '1'; }, /Database identity mismatch/],
    ]) {
      const bad = structuredClone(binding); change(bad);
      await negative(name, () => preflight({binding: bad, candidate: source, docker}), pattern);
    }
    const mismatched = {...source, apiTree: '0'.repeat(40)};
    await negative('candidate source mismatch', () => preflight({binding, candidate: mismatched, docker}), /Candidate source identity mismatch/);
    const configNegative = async (name, mutate, pattern) => {
      const changed = structuredClone(config); mutate(changed);
      await writeFile(configFile, JSON.stringify(changed));
      const reviewed = structuredClone(binding);
      reviewed.compose.files[0].sha256 = digest(await readFile(configFile));
      reviewed.compose.configSha256 = digest(JSON.stringify(JSON.parse((await docker([...compose, 'config', '--format', 'json'])).stdout)));
      await negative(name, () => preflight({binding: reviewed, candidate: source, docker}), pattern);
      await writeFile(configFile, JSON.stringify(config));
    };
    await configNegative('DNS host redirection', c => { c.services.api.extra_hosts = {db: '192.0.2.123'}; }, /Unsupported API service field/);
    await configNegative('PGOPTIONS schema redirection', c => { c.services.api.environment.PGOPTIONS = '-c search_path=wrong_schema'; }, /Unsupported connection/);
    await configNegative('photo subpath redirection', c => { c.services.api.volumes[0].volume = {subpath: 'empty'}; }, /Candidate service mount/);
    await configNegative('private upload path redirection', c => { c.services.api.environment.PRIVATE_UPLOAD_DIR = '/tmp/empty'; }, /Private upload path/);
    await sql(`CREATE SCHEMA ${database} AUTHORIZATION ${database};`);
    await negative('same ledger but changed creation schema', () => preflight({binding, candidate: source, docker}), /Database creation schema is not public/);
    await sql(`DROP SCHEMA ${database};`);
    // Real second empty PG instance; discovery cannot bless an absent ledger.
    const emptyProject = `${project}-empty`, emptyNetwork = `${project}_empty_network`, emptyFile = join(scratch, 'empty-compose.json');
    await resources.create('network', emptyNetwork, ['network', 'create', '--internal', ...labels, emptyNetwork]);
    const emptyConfig = structuredClone(config);
    emptyConfig.name = emptyProject; emptyConfig.volumes.database.name = volumes.empty;
    emptyConfig.networks.default.name = emptyNetwork;
    for (const service of ['api', 'db']) emptyConfig.services[service].container_name = `${emptyProject}-${service}`;
    await writeFile(emptyFile, JSON.stringify(emptyConfig), {mode: 0o600});
    for (const service of ['db', 'api']) await resources.absent('container', `${emptyProject}-${service}`);
    try { await docker(['compose', '--project-name', emptyProject, '--env-file', envFile, '-f', emptyFile, 'create', '--no-build', '--pull', 'never', 'db', 'api']); }
    finally {
      for (const name of await resources.names('container')) if (name === `${emptyProject}-db` || name === `${emptyProject}-api`) await resources.capture('container', name);
    }
    const emptyId = resources.records.find(record => record.name === `${emptyProject}-db`).identity.id;
    await docker(['start', emptyId]); await waitForDb(emptyId);
    await negative('real uninitialized stack has no migration ledger', () => discoverBinding({endpoint: env.DOCKER_HOST,
      project: emptyProject, files: [emptyFile], envFile, apiOrigin: source.apiOrigin, docker}), /schema_migrations.*does not exist/s);
    await helper(['--network', emptyNetwork, '--env', 'PGHOST=db', '--env', 'PGPORT=5432', '--env', `PGUSER=${database}`,
      '--env', `PGDATABASE=${database}`, '--env', `PGPASSWORD=${password}`], ['apps/api/dist/migrate.js']);
    const emptyProposal = await discoverBinding({endpoint: env.DOCKER_HOST, project: emptyProject, files: [emptyFile], envFile, apiOrigin: source.apiOrigin, docker});
    assert.equal(emptyProposal.database.migrationsSha256, binding.database.migrationsSha256);
    assert.notEqual(emptyProposal.database.systemIdentifier, binding.database.systemIdentifier);
    const families = await docker(['exec', emptyId, 'sh', '-c', 'exec env -i PATH="$PATH" PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM families"']);
    assert.equal(families.stdout.trim(), '0');
    await negative('same-schema empty instance cannot match the retained original database identity', () => preflight({
      binding: {...emptyProposal, database: binding.database, review: binding.review}, candidate: source, docker}), /Database identity mismatch/);
    for (const service of ['api', 'db']) await resources.remove(resources.records.find(record => record.name === `${emptyProject}-${service}`));
    await resources.remove(resources.records.find(record => record.name === emptyNetwork));
    const bindingFile = join(scratch, 'binding.json'); await writeFile(bindingFile, JSON.stringify(binding), {mode: 0o600});
    const backupRoot = join(scratch, 'backup');
    await run('bash', ['scripts/staging-backup.sh', envFile, backupRoot, bindingFile]);
    const complete = join(backupRoot, (await readdir(backupRoot))[0]);
    await run('sha256sum', ['-c', 'SHA256SUMS'], {cwd: complete});
    const backupReceipt = JSON.parse(await readFile(join(complete, 'deployment-identity.json'), 'utf8'));
    assert.equal(backupReceipt.dbId, dbId); assert.equal(backupReceipt.bindingSha256, digest(JSON.stringify(binding)));
    checks.push({name: 'bound backup ignores DB-container libpq overrides', status: 'PASS'});
    // Candidate probe runs, then a changed reviewed receipt blocks all Compose up.
    const beforeDrift = calls.length;
    await assert.rejects(applyCandidate({binding, candidate: source, confirmed: true, docker,
      reload: async () => ({binding: {...binding, project: `${project}-changed`}, candidate: source})}), /Binding file/);
    assert.equal(calls.slice(beforeDrift).filter(args => args[0] === 'run').length, 1);
    assert(!calls.slice(beforeDrift).some(args => args.includes('up')));
    checks.push({name: 'candidate SELECT probe then binding drift refuses apply', status: 'PASS'});
    const beforeNames = {volumes: await resources.names('volume'), networks: await resources.names('network')};
    const applied = await applyCandidate({binding, candidate: source, confirmed: true, docker});
    assert.notEqual(applied.apiId, apiId);
    const oldRecord = resources.records.find(record => record.identity.id === apiId);
    const actual = await resources.snapshot('container', `${project}-api`);
    assert.equal(actual.id, applied.apiId); assert.equal(actual.labels[ownerLabel], project);
    resources.records.splice(resources.records.indexOf(oldRecord), 1);
    await resources.capture('container', `${project}-api`);
    assert.deepEqual(await resources.names('volume'), beforeNames.volumes);
    assert.deepEqual(await resources.names('network'), beforeNames.networks);
    const readyUntil = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < readyUntil) {
      try {
        await docker(['exec', applied.apiId, 'node', '-e', "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], {timeout: 5000}); ready = true; break;
      } catch (error) { if (!exitedWithFailure(error) || interrupted) throw error; await delay(1000); }
    }
    assert(ready, 'Replacement API must become ready in the synthetic network');
    assert.equal((await sql(snapshotSql)).stdout.trim(), before);
    assert.equal(await photoDigest(), beforePhoto);
    assert.equal((await docker(['inspect', '--format', '{{.State.Status}}', dbId])).stdout.trim(), 'running');
    assert.equal((await docker(['inspect', '--format', '{{index .Config.Labels "literal"}}', applied.apiId])).stdout.trim(), 'synthetic-$literal');
    const up = calls.filter(args => args.includes('up'));
    assert.equal(up.length, 1);
    assert.deepEqual(up[0].slice(up[0].indexOf('up')), ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api']);
    checks.push({name: 'only API replaced, original DB/volumes/network and synthetic content preserved', status: 'PASS',
      apiBefore: apiId, apiAfter: applied.apiId, dbId, syntheticContentSha256: digest(before), syntheticPhotoSha256: beforePhoto});
    await mkdir(artifactDir, {recursive: true});
    await writeFile(join(artifactDir, 'bound-backup-identity.json'), JSON.stringify(backupReceipt, null, 2));
  } catch (error) { failure = error; }
  finally {
    try { await resources.cleanup(); await resources.assertEmpty(); checks.push({name: 'owned resources removed by full identity', status: 'PASS'}); }
    catch (error) { failure = new AggregateError([failure, error].filter(Boolean), 'Synthetic exercise cleanup failed; unknown resources retained'); }
    await mkdir(artifactDir, {recursive: true});
    await writeFile(join(artifactDir, 'result.json'), `${JSON.stringify({schemaVersion: 1, layer: 'SYNTHETIC',
      status: failure ? 'FAIL' : 'PASS', source, postgresImage: pgImage, project, checks,
      production: 'NOT_RUN', limitation: 'Docker checks are not an atomic lock; owner maintenance exclusivity is required'}, null, 2)}\n`);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    // Only this invocation's fresh local synthetic directory; Docker images/cache
    // are left to disposal of the hosted runner, never pruned globally.
    if (!failure) await rm(scratch, {recursive: true, force: true});
  }
  if (failure) throw failure;
  console.log(`PASS: ${checks.length} synthetic existing-deployment identity checks; production NOT_RUN`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exerciseDeploymentGuard().catch(error => { console.error(error); process.exitCode = 1; });
}

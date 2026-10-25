import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, readFile} from 'node:fs/promises';
import {digest} from './build-api-candidate.mjs';
import {preflight, applyCandidate, apiOnlyConfig, validateBinding, discoverBinding, databaseIdentity} from './deployment-guard.mjs';
import {deploymentFixture, fakeDocker} from './test-support/deployment-fixture.mjs';

const dangerous = calls => calls.filter(args => ['run', 'start', 'stop', 'rm', 'pull', 'build', 'create'].includes(args[0]) || args.includes('up') || args.includes('down'));
test('reviewed stopped existing stack preflight is read-only and emits no private configuration', async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    const result = await preflight({...f, docker: fake.docker});
    assert.equal(result.receipt.status, 'PASS');
    assert.equal(result.receipt.deployment, 'NOT_PERFORMED');
    assert.equal(JSON.stringify(result.receipt).includes('synthetic-provider-secret'), false);
    assert.deepEqual(dangerous(fake.calls), []);
    assert(fake.calls.filter(args => args[0] === 'compose').every(args => args.includes('--project-name') && args.includes(f.binding.project)));
    assert(fake.calls.filter(args => args[0] === 'exec').every(args => args[1] === f.binding.db.id));
  } finally { await f.close(); }
});

test('read-only DB probe parses all 36 migration records from real multiline psql JSON', async () => {
  // Captured using PostgreSQL 17.6, BEGIN READ ONLY and synthetic generate_series;
  // trailing line spaces normalized for the repository, record newlines retained.
  // json_agg(composite rows) emits newlines even with psql's unaligned tuples mode.
  const bytes = await readFile(new URL('./test-support/deployment-identity-multiline.json', import.meta.url), 'utf8');
  const probe = JSON.parse(bytes);
  assert.equal(probe.migrations.length, 36); assert(bytes.trim().split('\n').length > 1);
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    f.binding.database = databaseIdentity(probe);
    f.candidate.migrationsSha256 = f.binding.database.migrationsSha256;
    f.candidate.migrationCount = 36;
    const docker = async args => {
      const result = await fake.docker(args);
      if (args[0] !== 'exec') return result;
      assert(args.at(-1).startsWith('BEGIN READ ONLY;'));
      // Also reproduce real psql's command tags unless quiet mode suppresses them.
      return {stdout: /(?:^|\s)-q(?:\s|$)/.test(args[4]) ? bytes : `BEGIN\n${bytes}COMMIT\n`};
    };
    const result = await preflight({...f, docker});
    assert.equal(result.receipt.databaseFingerprint, digest(JSON.stringify(f.binding.database)));
    assert.deepEqual(dangerous(fake.calls), []);
  } finally { await f.close(); }
});

test('DB probe refuses truncated JSON and unexpected trailing stdout', async () => {
  for (const corrupt of [value => value.slice(0, -1), value => `${value}\nUNEXPECTED OUTPUT`]) {
    const f = await deploymentFixture(), fake = fakeDocker(f.state);
    try {
      const docker = async args => {
        const result = await fake.docker(args);
        return args[0] === 'exec' ? {stdout: corrupt(result.stdout)} : result;
      };
      await assert.rejects(preflight({...f, docker}), /Invalid database probe JSON/);
      assert.deepEqual(dangerous(fake.calls), []);
    } finally { await f.close(); }
  }
});

const cases = {
  unreviewed: f => { f.binding.review.status = 'UNREVIEWED'; },
  daemon: f => { f.state.daemonId = 'other-daemon'; },
  project: f => { f.state.containers[f.state.apiId].labels['com.docker.compose.project'] = 'wrong-empty-stack'; },
  container: f => { f.state.apiId = '8'.repeat(64); },
  multiple: f => { f.state.apiId += '\n' + '8'.repeat(64); },
  running: f => { f.state.containers[f.state.apiId].state = 'running'; },
  dbStopped: f => { f.state.containers[f.state.dbId].state = 'exited'; },
  volumeMissing: f => { delete f.state.volumes[f.binding.volumes.database.name]; },
  volumeReplaced: f => { f.state.volumes[f.binding.volumes.database.name] = {...f.binding.volumes.database, created: '2026-10-25T00:00:00Z'}; },
  photoMount: f => { f.state.containers[f.state.apiId].mounts[0].Name = 'wrong-photos'; },
  emptyDatabase: f => { f.state.probe.migrations = []; },
  wrongInstance: f => { f.state.probe.systemIdentifier = '999999999999'; },
  wrongDatabase: f => { f.state.probe.oid = '999'; },
  sameLedgerDifferentCreationSchema: f => { f.state.probe.schema = 'syntheticdb'; f.state.probe.schemas = ['syntheticdb', 'public']; },
  databaseWriter: f => { f.state.probe.otherClients = 1; },
  networkPeer: f => { f.state.network.containers['8'.repeat(64)] = {Name: 'unknown-writer'}; },
  extraVolumeConsumer: f => {
    const c = structuredClone(f.state.containers[f.state.apiId]); c.id = '8'.repeat(64); c.state = 'running'; f.state.containers[c.id] = c;
  },
  candidateSource: f => { f.state.image.labels['io.medbox.api-tree'] = '8'.repeat(40); },
  candidateMigration: f => { f.candidate.migrationCount = 2; },
  candidateOrigin: f => { f.candidate.apiOrigin = 'https://other.invalid'; },
  inheritedImageConnection: f => { f.state.image.envKeys.push('PGOPTIONS'); },
  existingApiConnectionOverride: f => { f.state.containers[f.state.apiId].envKeys.push('PGOPTIONS'); },
};
for (const [reason, mutate] of Object.entries(cases)) test(`preflight refuses ${reason} before any mutation`, async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try { mutate(f); await assert.rejects(preflight({...f, docker: fake.docker})); assert.deepEqual(dangerous(fake.calls), []); }
  finally { await f.close(); }
});

for (const [reason, mutate] of Object.entries({
  remoteHost: c => { c.services.api.environment.PGHOST = 'other-db'; },
  databaseUrl: c => { c.services.api.environment.DATABASE_URL = 'postgres://synthetic/wrong'; },
  otherSchema: c => { c.services.api.environment.PGOPTIONS = '-c search_path=other_schema'; },
  extraHosts: c => { c.services.api.extra_hosts = {'db': '192.0.2.12'}; },
  customDns: c => { c.services.api.dns = ['192.0.2.53']; },
  photoSubpath: c => { c.services.api.volumes[0].volume = {subpath: 'empty'}; },
  privateUploadRedirect: c => { c.services.api.environment.PRIVATE_UPLOAD_DIR = '/tmp/other'; },
  lifecycleHook: c => { c.services.api.post_start = [{command: 'unexpected'}]; },
  expiryReminderJob: c => { c.services.api.environment.WECHAT_REMINDER_SCHEDULER_ENABLED = 'true'; },
  doseReminderJob: c => { c.services.api.environment.WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED = 'true'; },
  photoCleanupJob: c => { c.services.api.environment.LEAFLET_PHOTO_CLEANUP_ENABLED = 'true'; },
  implicitMaintenanceJob: c => { delete c.services.api.environment.LEAFLET_PHOTO_CLEANUP_ENABLED; },
  wrongVolume: c => { c.volumes.database.name = 'new-empty-volume'; },
  wrongNetwork: c => { c.networks.default.name = 'wrong-network'; },
  overriddenCommand: c => { c.services.api.command = ['sh', '-c', 'unexpected']; },
  extraMount: c => { c.services.api.volumes.push({type: 'bind', source: '/tmp', target: '/unsafe'}); },
})) test(`even a reviewed config cannot redirect ${reason}`, async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    mutate(f.state.config); f.binding.compose.configSha256 = digest(JSON.stringify(f.state.config));
    await assert.rejects(preflight({...f, docker: fake.docker})); assert.deepEqual(dangerous(fake.calls), []);
  } finally { await f.close(); }
});

test('changed Compose input is rejected before querying or modifying containers', async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    await writeFile(f.binding.compose.files[0].path, '{}');
    await assert.rejects(preflight({...f, docker: fake.docker}), /Compose file/);
    assert.deepEqual(dangerous(fake.calls), []);
  } finally { await f.close(); }
});

test('apply requires explicit confirmation, probes candidate read-only, rechecks and replaces only API', async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    await assert.rejects(applyCandidate({...f, docker: fake.docker}), /Explicit/);
    assert.deepEqual(fake.calls, []);
    const result = await applyCandidate({...f, confirmed: true, docker: fake.docker});
    assert.equal(result.deployment, 'API_REPLACED_HEALTH_AND_REAL_DATA_NOT_VERIFIED');
    const run = fake.calls.find(args => args[0] === 'run');
    assert(run.includes('--read-only') && run.includes('--pull=never') && run.includes(f.binding.network.id));
    assert(!run.includes('--mount')); assert.equal(run[run.indexOf('--entrypoint') + 1], 'node');
    assert(!JSON.stringify(run).includes('synthetic-only')); assert(!JSON.stringify(run).includes('synthetic-provider'));
    const up = fake.calls.find(args => args.includes('up'));
    assert.deepEqual(up.slice(up.indexOf('up')), ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api']);
    assert.equal(up[up.indexOf('--project-name') + 1], f.binding.project);
    assert.deepEqual(Object.keys(f.state.applied.services), ['api']);
    assert.equal(f.state.applied.services.api.image, f.candidate.imageId);
    assert.equal(f.state.applied.services.api.environment.PGPASSWORD, 'synthetic-only-$$literal');
    assert(Object.values(f.state.applied.volumes).every(v => v.external === true));
    assert(Object.values(f.state.applied.networks).every(v => v.external === true));
    assert.equal(f.state.dbId, f.binding.db.id);
    assert.equal(f.binding.api.id, 'a'.repeat(64), 'reviewed baseline is never silently rewritten');
  } finally { await f.close(); }
});

test('binding or live volume drift after candidate probe blocks up', async () => {
  for (const mode of ['binding', 'volume']) {
    const f = await deploymentFixture(), fake = fakeDocker(f.state);
    try {
      const docker = async args => {
        const result = await fake.docker(args);
        if (args[0] === 'run' && mode === 'volume') f.state.volumes[f.binding.volumes.photos.name] = {...f.binding.volumes.photos, created: '2026-10-25T00:00:00Z'};
        return result;
      };
      const reload = async () => ({binding: mode === 'binding' ? {...f.binding, project: 'changed'} : f.binding, candidate: f.candidate});
      await assert.rejects(applyCandidate({...f, confirmed: true, docker, reload}));
      assert(!fake.calls.some(args => args.includes('up')));
    } finally { await f.close(); }
  }
});

test('API-only execution has no DB definition, build, dependencies or creation-capable volumes', async () => {
  const f = await deploymentFixture();
  try {
    const config = apiOnlyConfig(f.state.config, f.binding, f.candidate, 'default');
    assert.deepEqual(Object.keys(config.services), ['api']);
    assert.equal(config.services.api.build, undefined); assert.equal(config.services.api.depends_on, undefined);
    assert.deepEqual(config.volumes.photos, {external: true, name: f.binding.volumes.photos.name});
    assert.deepEqual(config.networks.default, {external: true, name: f.binding.network.name});
    const discovery = {...f.binding, review: {status: 'UNREVIEWED'}};
    assert.throws(() => validateBinding(discovery), /independently reviewed/);
  } finally { await f.close(); }
});

test('Docker probe passwords and all resolved Compose strings retain literal meaning', async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    const password = "#'quoted-$PASSWORD'";
    f.state.config.services.api.environment.PGPASSWORD = password;
    f.state.config.services.api.labels = {literal: '$UNCHANGED'};
    f.state.config.services.api.healthcheck = {test: ['CMD-SHELL', 'test "$HEALTH" = ok']};
    f.binding.compose.configSha256 = digest(JSON.stringify(f.state.config));
    let dockerEnv;
    const docker = async args => {
      if (args[0] === 'run') dockerEnv = await readFile(args[args.indexOf('--env-file') + 1], 'utf8');
      if (args.includes('up')) assert.equal(await readFile(args[args.indexOf('--env-file') + 1], 'utf8'), '');
      return fake.docker(args);
    };
    await applyCandidate({...f, docker, confirmed: true});
    assert(dockerEnv.includes(`PGPASSWORD=${password}\n`));
    assert.equal(f.state.applied.services.api.labels.literal, '$$UNCHANGED');
    assert.equal(f.state.applied.services.api.healthcheck.test[1], 'test "$$HEALTH" = ok');
  } finally { await f.close(); }
});

test('discovery records existing identities but cannot approve its own proposal', async () => {
  const f = await deploymentFixture(), fake = fakeDocker(f.state);
  try {
    const proposal = await discoverBinding({endpoint: f.binding.endpoint, project: f.binding.project,
      files: f.binding.compose.files.map(file => file.path), envFile: f.binding.compose.envFile,
      apiOrigin: f.binding.apiOrigin, docker: fake.docker});
    assert.equal(proposal.review.status, 'UNREVIEWED');
    assert.deepEqual(proposal.database, f.binding.database);
    await assert.rejects(preflight({binding: proposal, docker: fake.docker}), /independently reviewed/);
    assert.deepEqual(dangerous(fake.calls), []);
  } finally { await f.close(); }
});

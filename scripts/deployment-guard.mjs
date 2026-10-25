// Existing-stack maintenance only. No database/volume creation, deletion or migration.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {lstat, readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest, sourceLabels} from './build-api-candidate.mjs';

const hex40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
const must = (condition, message) => { if (!condition) throw new Error(message); };
const same = (actual, expected, label) => {
  try { assert.deepEqual(actual, expected); } catch { throw new Error(`${label} identity mismatch`); }
};
const active = state => !['created', 'exited'].includes(state);
const uploadRoot = '/var/lib/medbox/private-uploads';
const dataRoot = '/var/lib/postgresql/data';
const pgKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
const json = (value, label) => { try { return JSON.parse(value); } catch { throw new Error(`Invalid ${label} JSON`); } };
function connectionKeys(keys, {image = false} = {}) {
  must(Array.isArray(keys) && keys.every(key => typeof key === 'string' &&
    key !== 'DATABASE_URL' && !['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD'].includes(key) &&
    (!key.startsWith('PG') || (!image && pgKeys.includes(key)))), 'Unsupported connection or process environment override');
}
export const inspectFormats = {
  container: '{"id":{{json .Id}},"image":{{json .Image}},"state":{{json .State.Status}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"networkMode":{{json .HostConfig.NetworkMode}},"uploadPaths":[{{range .Config.Env}}{{if eq (index (split . "=") 0) "PRIVATE_UPLOAD_DIR"}}{{json .}},{{end}}{{end}}""],"envKeys":[{{range .Config.Env}}{{json (index (split . "=") 0)}},{{end}}""],"safeEnv":[{{range .Config.Env}}{{$k := index (split . "=") 0}}{{if or (eq $k "PGHOST") (eq $k "PGPORT") (eq $k "PGDATABASE") (eq $k "PGUSER")}}{{json .}},{{end}}{{if eq $k "DATABASE_URL"}}"DATABASE_URL_PRESENT",{{end}}{{end}}""]}',
  volume: '{"name":{{json .Name}},"created":{{json .CreatedAt}},"mountpoint":{{json .Mountpoint}},"driver":{{json .Driver}},"scope":{{json .Scope}},"labels":{{json .Labels}},"options":{{json .Options}}}',
  network: '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"internal":{{json .Internal}},"labels":{{json .Labels}},"containers":{{json .Containers}}}',
  image: '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"envKeys":[{{range .Config.Env}}{{json (index (split . "=") 0)}},{{end}}""],"uploadPaths":[{{range .Config.Env}}{{if eq (index (split . "=") 0) "PRIVATE_UPLOAD_DIR"}}{{json .}},{{end}}{{end}}""]}',
};

// This query exposes no business rows, connection strings, passwords or user tokens.
export const identitySql = `SELECT json_build_object(
  'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
  'name',current_database(),'user',current_user,'schema',current_schema(),'schemas',current_schemas(false),
  'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
  'migrations',(SELECT coalesce(json_agg(t ORDER BY name),'[]'::json) FROM (SELECT name,checksum FROM schema_migrations) t),
  'otherClients',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()));`;

export function databaseIdentity(probe) {
  must(probe && typeof probe === 'object', 'Missing database identity');
  must(/^\d+$/.test(probe.systemIdentifier ?? '') && /^\d+$/.test(probe.oid ?? ''), 'Unknown database instance');
  must(name(probe.name) && name(probe.user), 'Unknown database name or user');
  must(probe.schema === 'public', 'Database creation schema is not public');
  same(probe.schemas, ['public'], 'Database search path');
  must(probe.otherClients === 0, 'Other database clients are present; exclusive maintenance is required');
  must(Array.isArray(probe.migrations) && probe.migrations.length > 0, 'Empty or uninitialized database ledger');
  const migrations = [...probe.migrations].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  must(migrations.every(row => /^\d+_[a-z0-9_-]+\.sql$/i.test(row.name ?? '') && hex64(row.checksum)), 'Invalid database migration ledger');
  must(new Set(migrations.map(row => row.name)).size === migrations.length, 'Duplicate database migrations');
  return {systemIdentifier: probe.systemIdentifier, name: probe.name, user: probe.user, oid: probe.oid, schema: probe.schema, schemas: probe.schemas,
    migrationsSha256: digest(JSON.stringify(migrations)), migrationCount: migrations.length};
}

export async function regularFile(path, limit = 2 * 1024 * 1024) {
  must(isAbsolute(path), 'Use an absolute local file path');
  const info = await lstat(path);
  must(info.isFile() && !info.isSymbolicLink() && info.size <= limit, 'Expected a bounded regular file');
  return readFile(path, 'utf8');
}

export function validateBinding(binding, {reviewed = true} = {}) {
  must(binding?.schemaVersion === 1 && binding.kind === 'MEDBOX_EXISTING_DEPLOYMENT_BINDING', 'Existing deployment binding required');
  if (reviewed) must(binding.review?.status === 'OWNER_REVIEWED' &&
    typeof binding.review.reference === 'string' && binding.review.reference.trim().length >= 8,
  'Binding must be independently reviewed; discovery is not approval');
  must(/^unix:\/\/\/[a-zA-Z0-9_./-]+\.sock$/.test(binding.endpoint ?? ''), 'An explicit local Docker socket is required');
  must(/^[a-z0-9][a-z0-9_-]*$/.test(binding.project ?? '') && /^[A-Za-z0-9:-]{1,128}$/.test(binding.daemonId ?? ''), 'Invalid Docker project or daemon identity');
  must(hex64(binding.api?.id) && imageId(binding.api?.image) && hex64(binding.db?.id) && imageId(binding.db?.image) && binding.api.id !== binding.db.id, 'Fixed existing container identities are required');
  for (const volume of Object.values(binding.volumes ?? {})) must(name(volume.name) && volume.created && volume.mountpoint && volume.driver === 'local' && volume.scope === 'local', 'Fixed local volume fingerprints required');
  must(Object.keys(binding.volumes ?? {}).sort().join(',') === 'database,photos' && binding.volumes.database.name !== binding.volumes.photos.name, 'Two distinct original volumes required');
  must(hex64(binding.network?.id) && name(binding.network?.name) && binding.network.driver === 'bridge', 'Existing bridge network identity required');
  must(Array.isArray(binding.compose?.files) && binding.compose.files.length > 0 && binding.compose.files.length <= 5 &&
    binding.compose.files.every(file => isAbsolute(file.path) && hex64(file.sha256)) && isAbsolute(binding.compose.envFile) && hex64(binding.compose.configSha256), 'Reviewed Compose inputs required');
  must(hex64(binding.database?.migrationsSha256) && binding.database.migrationCount > 0 && /^\d+$/.test(binding.database.systemIdentifier ?? '') && /^\d+$/.test(binding.database.oid ?? ''), 'Reviewed database fingerprint required');
  must(binding.database.schema === 'public', 'Only the public application schema is supported');
  same(binding.database.schemas, ['public'], 'Reviewed database search path');
  const origin = new URL(binding.apiOrigin);
  must(origin.protocol === 'https:' && origin.origin === binding.apiOrigin && !origin.username && !origin.password, 'Exact HTTPS API origin required');
}

export function dockerRunner(endpoint) {
  return async (args, {timeout = 60_000} = {}) => {
    const config = await mkdtemp(join(tmpdir(), 'medbox-docker-client-'));
    try {
      return await new Promise((resolvePromise, reject) => {
        // No saved Docker credentials/context, Compose files, PG variables,
        // provider secrets or ambient .env. Only a fresh private client config.
        const env = {PATH: process.env.PATH, DOCKER_HOST: endpoint, DOCKER_CONFIG: config, COMPOSE_DISABLE_ENV_FILE: '1'};
        execFile('docker', ['--host', endpoint, ...args], {encoding: 'utf8', env, timeout, maxBuffer: 8 * 1024 * 1024},
          (error, stdout) => {
            if (error) {
              // Docker/Compose errors can echo expanded secrets. Never propagate raw output.
              const failure = new Error(`Docker operation failed: ${args[0]} ${args[1] ?? ''}`);
              failure.exitCode = Number.isInteger(error.code) ? error.code : null;
              failure.interrupted = Boolean(error.killed || error.signal || typeof error.code === 'string');
              reject(failure);
            } else resolvePromise({stdout});
          });
      });
    } finally { await rm(config, {recursive: true, force: true}); }
  };
}

async function inspect(docker, kind, id) {
  return json((await docker([kind, 'inspect', '--format', inspectFormats[kind], id])).stdout, 'Docker identity');
}
function composeArgs(binding) {
  return ['compose', '--project-name', binding.project, '--env-file', binding.compose.envFile,
    ...binding.compose.files.flatMap(file => ['-f', file.path])];
}
async function composeConfig(binding, docker) {
  for (const file of binding.compose.files) same(digest(await regularFile(file.path)), file.sha256, 'Compose file');
  const envInfo = await lstat(binding.compose.envFile);
  must(envInfo.isFile() && !envInfo.isSymbolicLink(), 'Private env input must be a regular file');
  const config = json((await docker([...composeArgs(binding), 'config', '--format', 'json'])).stdout, 'Compose configuration');
  same(digest(JSON.stringify(config)), binding.compose.configSha256, 'Resolved Compose configuration');
  return config;
}
function volumeAt(container, destination) {
  must(Array.isArray(container.mounts) && container.mounts.length === 1, 'Unexpected additional or missing container mount');
  const mount = container.mounts[0];
  must(mount.Type === 'volume' && mount.Destination === destination && mount.RW === true && name(mount.Name), 'Expected the original writable named volume mount');
  return mount.Name;
}
function connection(config) {
  const env = config.services?.api?.environment;
  must(env && !Array.isArray(env) && !Object.hasOwn(env, 'DATABASE_URL'), 'Only explicit PG connection fields are supported; DATABASE_URL overrides are forbidden');
  connectionKeys(Object.keys(env));
  must(env.PGHOST === 'db' && String(env.PGPORT) === '5432' && name(env.PGDATABASE) && name(env.PGUSER) && typeof env.PGPASSWORD === 'string' && env.PGPASSWORD.length > 0, 'Candidate database connection is incomplete or redirected');
  return {PGHOST: env.PGHOST, PGPORT: String(env.PGPORT), PGDATABASE: env.PGDATABASE, PGUSER: env.PGUSER};
}
function validateService(config, binding, updating = false) {
  must(config.name === binding.project && config.services?.api && config.services?.db, 'Unknown Compose project or services');
  const api = config.services.api, db = config.services.db;
  if (updating) {
    const supported = ['build', 'image', 'restart', 'init', 'environment', 'ports', 'volumes', 'networks', 'depends_on', 'healthcheck', 'labels', 'container_name', 'profiles', 'pull_policy'];
    must(Object.keys(api).every(key => supported.includes(key)), 'Unsupported API service field; this entry only supports the reviewed staging layout');
    for (const key of ['WECHAT_REMINDER_SCHEDULER_ENABLED', 'WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED', 'LEAFLET_PHOTO_CLEANUP_ENABLED']) {
      must(api.environment?.[key] === 'false', 'Candidate maintenance jobs must all be explicitly disabled');
    }
  }
  for (const key of ['volumes_from', 'network_mode', 'extra_hosts', 'dns', 'dns_search', 'dns_opt', 'privileged', 'devices', 'pid', 'ipc', 'cap_add', 'configs', 'secrets', 'post_start', 'pre_stop', 'use_api_socket']) {
    must(api[key] === undefined || api[key] === null || api[key] === false, `Unsupported API execution override: ${key}`);
  }
  must(Object.keys(api.networks ?? {}).length === 1 && Object.keys(db.networks ?? {}).length === 1, 'Only one explicitly bound service network is supported');
  const networkKey = Object.keys(api.networks)[0];
  must(Object.keys(db.networks)[0] === networkKey && config.networks?.[networkKey]?.name === binding.network.name, 'Candidate DB and API network differ from the binding');
  for (const [service, target, volumeName] of [[api, uploadRoot, binding.volumes.photos.name], [db, dataRoot, binding.volumes.database.name]]) {
    must(service.volumes?.length === 1 && service.volumes[0].type === 'volume' && service.volumes[0].target === target && !service.volumes[0].read_only && !service.volumes[0].volume?.subpath, 'Candidate service mount differs from the original');
    must(config.volumes?.[service.volumes[0].source]?.name === volumeName, 'Candidate service selects another volume');
  }
  const pg = connection(config);
  must(api.environment.PRIVATE_UPLOAD_DIR === undefined || api.environment.PRIVATE_UPLOAD_DIR === uploadRoot, 'Private upload path differs from the bound photo mount');
  must(pg.PGDATABASE === binding.database.name && pg.PGUSER === binding.database.user, 'Candidate database name/user differs from the binding');
  must(db.environment?.POSTGRES_DB === pg.PGDATABASE && db.environment?.POSTGRES_USER === pg.PGUSER, 'Compose DB and API connection disagree');
  return {pg, networkKey};
}

async function readDatabase(docker, binding) {
  const result = await docker(['exec', binding.db.id, 'sh', '-c',
    'exec env -i PATH="$PATH" PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -t -v ON_ERROR_STOP=1 -c "$1"', 'sh', `BEGIN READ ONLY; ${identitySql} COMMIT;`]);
  const line = result.stdout.trim().split('\n').find(value => value.startsWith('{'));
  return databaseIdentity(json(line ?? 'null', 'database probe'));
}

// Discovery is evidence collection only. A proposal can never authorize backup/apply.
export async function discoverBinding({endpoint, project, files, envFile, apiOrigin, docker = dockerRunner(endpoint)}) {
  must(/^unix:\/\/\/[a-zA-Z0-9_./-]+\.sock$/.test(endpoint ?? '') && /^[a-z0-9][a-z0-9_-]*$/.test(project ?? ''), 'Explicit local endpoint and project required');
  must(Array.isArray(files) && files.length > 0 && files.length <= 5, 'Explicit Compose files required');
  const compose = {files: await Promise.all(files.map(async path => ({path, sha256: digest(await regularFile(path))}))), envFile};
  await regularFile(envFile);
  const binding = {schemaVersion: 1, kind: 'MEDBOX_EXISTING_DEPLOYMENT_BINDING',
    review: {status: 'UNREVIEWED', reference: ''}, endpoint, project, apiOrigin, compose,
    daemonId: (await docker(['info', '--format', '{{.ID}}'])).stdout.trim()};
  const config = json((await docker([...composeArgs(binding), 'config', '--format', 'json'])).stdout, 'Compose configuration');
  compose.configSha256 = digest(JSON.stringify(config));
  const containers = {};
  for (const service of ['api', 'db']) {
    const id = (await docker([...composeArgs(binding), 'ps', '--all', '--quiet', service])).stdout.trim();
    must(hex64(id), 'Expected one existing container per service');
    const current = await inspect(docker, 'container', id);
    must(current.id === id && current.labels?.['com.docker.compose.project'] === project && current.labels?.['com.docker.compose.service'] === service, 'Discovery project/container mismatch');
    must(service === 'api' ? !active(current.state) : current.state === 'running', 'Discovery requires a stopped API and running DB');
    binding[service] = {id, image: current.image}; containers[service] = current;
  }
  binding.volumes = {database: await inspect(docker, 'volume', volumeAt(containers.db, dataRoot)),
    photos: await inspect(docker, 'volume', volumeAt(containers.api, uploadRoot))};
  const networks = Object.values(containers.db.networks ?? {});
  must(networks.length === 1 && hex64(networks[0].NetworkID), 'Discovery requires one existing network');
  const network = await inspect(docker, 'network', networks[0].NetworkID);
  delete network.containers;
  binding.network = network;
  binding.database = await readDatabase(docker, binding);
  validateBinding(binding, {reviewed: false});
  validateService(config, binding);
  return binding;
}

export async function preflight({binding, candidate, docker = dockerRunner(binding.endpoint)}) {
  validateBinding(binding);
  const daemon = (await docker(['info', '--format', '{{.ID}}'])).stdout.trim();
  same(daemon, binding.daemonId, 'Docker daemon');
  const config = await composeConfig(binding, docker);
  const {pg, networkKey} = validateService(config, binding, Boolean(candidate));
  const containers = {};
  for (const service of ['api', 'db']) {
    const ids = (await docker([...composeArgs(binding), 'ps', '--all', '--quiet', service])).stdout.trim().split('\n').filter(Boolean);
    same(ids, [binding[service].id], `Compose ${service}`);
    const actual = await inspect(docker, 'container', binding[service].id);
    same({id: actual.id, image: actual.image}, binding[service], service);
    must(actual.labels?.['com.docker.compose.project'] === binding.project && actual.labels?.['com.docker.compose.service'] === service, 'Container project/service labels mismatch');
    must(service === 'api' ? !active(actual.state) : actual.state === 'running', 'API must be stopped and the bound DB must be running');
    const networks = Object.values(actual.networks ?? {});
    must(networks.length === 1 && (networks[0].NetworkID === binding.network.id ||
      (actual.state === 'created' && networks[0].NetworkID === '' && actual.networkMode === binding.network.name)), 'Container network identity changed');
    containers[service] = actual;
  }
  connectionKeys(containers.api.envKeys);
  same(containers.api.uploadPaths?.filter(Boolean), [`PRIVATE_UPLOAD_DIR=${uploadRoot}`], 'Existing API upload path');
  const oldPg = Object.fromEntries(containers.api.safeEnv.filter(Boolean).map(entry => {
    const separator = entry.indexOf('='); return separator < 0 ? [entry, true] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  same(oldPg, pg, 'Existing API connection');
  same(volumeAt(containers.api, uploadRoot), binding.volumes.photos.name, 'API photo mount');
  same(volumeAt(containers.db, dataRoot), binding.volumes.database.name, 'Database mount');
  for (const [key, expected] of Object.entries(binding.volumes)) {
    same(containers[key === 'database' ? 'db' : 'api'].mounts[0].Source, expected.mountpoint, 'Full original volume mount');
    same(await inspect(docker, 'volume', expected.name), expected, `${key} volume`);
    const consumers = (await docker(['ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${expected.name}`])).stdout.trim().split('\n').filter(Boolean);
    for (const id of consumers) {
      must(hex64(id), 'Unknown volume consumer');
      if (id === (key === 'database' ? binding.db.id : binding.api.id)) continue;
      must(!active((await inspect(docker, 'container', id)).state), 'Additional active volume consumer; stop all writers');
    }
  }
  const network = await inspect(docker, 'network', binding.network.id);
  const {containers: peers, ...identity} = network;
  same(identity, binding.network, 'Network');
  must(Object.keys(peers ?? {}).every(id => id === binding.api.id || id === binding.db.id), 'Additional network peer; exclusive maintenance is required');
  same(await readDatabase(docker, binding), binding.database, 'Database');
  if (candidate) {
    must(candidate.schemaVersion === 1 && candidate.kind === 'MEDBOX_API_CANDIDATE' &&
      [candidate.sourceSha, candidate.sourceTree, candidate.apiTree].every(hex40) && imageId(candidate.imageId) &&
      candidate.provenance === 'LOCAL_BUILD_RECEIPT_NOT_A_SIGNATURE', 'Valid exact-source API candidate receipt required');
    must(candidate.apiOrigin === binding.apiOrigin && candidate.migrationsSha256 === binding.database.migrationsSha256 && candidate.migrationCount === binding.database.migrationCount, 'Candidate origin or migrations differ; this gate does not authorize schema upgrades');
    const image = await inspect(docker, 'image', candidate.imageId);
    connectionKeys(image.envKeys, {image: true});
    same(image.uploadPaths?.filter(Boolean), [`PRIVATE_UPLOAD_DIR=${uploadRoot}`], 'Candidate upload path');
    same(image.id, candidate.imageId, 'Candidate image');
    for (const [key, value] of Object.entries(sourceLabels(candidate))) same(image.labels?.[key], value, 'Candidate source');
    // The image's ordinary entrypoint is used only after all probes/rechecks.
    same(image.command, ['node', 'apps/api/dist/server.js'], 'Candidate command');
    must(image.entrypoint === null || (Array.isArray(image.entrypoint) && image.entrypoint.join('|') === 'docker-entrypoint.sh'), 'Unsupported candidate entrypoint');
  }
  const receipt = {schemaVersion: 1, kind: 'MEDBOX_DEPLOYMENT_PREFLIGHT', status: 'PASS',
    bindingSha256: digest(JSON.stringify(binding)), project: binding.project, apiId: binding.api.id, dbId: binding.db.id,
    apiImage: binding.api.image, photoVolume: binding.volumes.photos.name,
    endpoint: binding.endpoint,
    databaseFingerprint: digest(JSON.stringify(binding.database)), candidateImage: candidate?.imageId ?? null,
    sourceSha: candidate?.sourceSha ?? null, deployment: 'NOT_PERFORMED'};
  // config contains private environment values; only receipt may be emitted.
  return {receipt, config, networkKey};
}

export function apiOnlyConfig(config, binding, candidate, networkKey) {
  const api = structuredClone(config.services.api);
  for (const key of ['build', 'depends_on', 'profiles', 'pull_policy']) delete api[key];
  api.image = candidate.imageId;
  api.networks = {[networkKey]: {aliases: ['api']}};
  const photoKey = api.volumes[0].source;
  const output = {name: binding.project, services: {api},
    volumes: {[photoKey]: {external: true, name: binding.volumes.photos.name}},
    networks: {[networkKey]: {external: true, name: binding.network.name}}};
  // The entire rendered config is literal on the second Compose read, including
  // health checks and labels. Password files use Docker's different env grammar.
  for (const value of Object.values(api.environment)) {
    must(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null, 'Unsupported environment value');
  }
  const literal = value => typeof value === 'string' ? value.replaceAll('$', () => '$$')
    : Array.isArray(value) ? value.map(literal)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literal(item)])) : value;
  return literal(output);
}

export async function applyCandidate({binding, candidate, confirmed = false, docker = dockerRunner(binding.endpoint), reload = async () => ({binding, candidate})}) {
  must(confirmed && candidate, 'Explicit --apply and candidate receipt required');
  const first = await preflight({binding, candidate, docker});
  const temporary = await mkdtemp(join(tmpdir(), 'medbox-deployment-'));
  try {
    const pg = first.config.services.api.environment;
    const env = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].map(key => {
      must(typeof pg[key] === 'string' && !/[\r\n\0]/.test(pg[key]), 'Invalid candidate database environment'); return `${key}=${pg[key]}`;
    }).join('\n');
    const envPath = join(temporary, 'database.env');
    await writeFile(envPath, `${env}\n`, {flag: 'wx', mode: 0o600});
    const composeEnvPath = join(temporary, 'empty.env');
    await writeFile(composeEnvPath, '', {flag: 'wx', mode: 0o600});
    const probe = `const {Client}=require('pg');const client=new Client();(async()=>{try{await client.connect();await client.query('BEGIN READ ONLY');const r=await client.query(${JSON.stringify(identitySql)});console.log(JSON.stringify(r.rows[0].json_build_object));await client.query('ROLLBACK');}catch{process.exitCode=1;}finally{await client.end();}})();`;
    // No mounts, application entrypoint, migrations, jobs or provider environment.
    const result = await docker(['run', '--rm', '--pull=never', '--network', binding.network.id, '--read-only',
      '--env-file', envPath, '--entrypoint', 'node', candidate.imageId, '-e', probe]);
    same(databaseIdentity(json(result.stdout.trim(), 'candidate database probe')), binding.database, 'Candidate database probe');
    const latest = await reload();
    same(latest.binding, binding, 'Binding file'); same(latest.candidate, candidate, 'Candidate receipt');
    const checked = await preflight({...latest, docker});
    same(checked.receipt, first.receipt, 'Preflight');
    const file = join(temporary, 'api-only.json');
    await writeFile(file, JSON.stringify(apiOnlyConfig(checked.config, binding, candidate, checked.networkKey)), {flag: 'wx', mode: 0o600});
    await docker(['compose', '--project-name', binding.project, '--env-file', composeEnvPath, '-f', file,
      'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'api'], {timeout: 180_000});
    // Do not roll back, remove resources, or rewrite the reviewed baseline on failure.
    const newId = (await docker(['compose', '--project-name', binding.project, '--env-file', composeEnvPath, '-f', file, 'ps', '--all', '--quiet', 'api'])).stdout.trim();
    must(hex64(newId), 'Expected exactly one replacement API');
    const replacement = await inspect(docker, 'container', newId);
    must(replacement.image === candidate.imageId && replacement.labels?.['com.docker.compose.project'] === binding.project && replacement.labels?.['com.docker.compose.service'] === 'api', 'Replacement API source/project mismatch');
    connectionKeys(replacement.envKeys);
    same(replacement.safeEnv.filter(Boolean).sort(), Object.entries(connection(checked.config)).map(([key, value]) => `${key}=${value}`).sort(), 'Replacement API connection');
    same(replacement.uploadPaths?.filter(Boolean), [`PRIVATE_UPLOAD_DIR=${uploadRoot}`], 'Replacement upload path');
    same(Object.values(replacement.networks ?? {}).map(value => value.NetworkID), [binding.network.id], 'Replacement network');
    same(volumeAt(replacement, uploadRoot), binding.volumes.photos.name, 'Replacement photo mount');
    same(replacement.mounts[0].Source, binding.volumes.photos.mountpoint, 'Replacement full photo mount');
    const keptDb = await inspect(docker, 'container', binding.db.id);
    same({id: keptDb.id, image: keptDb.image}, binding.db, 'Preserved DB');
    must(keptDb.state === 'running', 'Original DB must remain running');
    same(volumeAt(keptDb, dataRoot), binding.volumes.database.name, 'Preserved database mount');
    same(keptDb.mounts[0].Source, binding.volumes.database.mountpoint, 'Preserved full database mount');
    same(Object.values(keptDb.networks ?? {}).map(value => value.NetworkID), [binding.network.id], 'Preserved database network');
    for (const [key, volume] of Object.entries(binding.volumes)) same(await inspect(docker, 'volume', volume.name), volume, `Preserved ${key} volume`);
    return {...checked.receipt, apiId: newId, apiImage: candidate.imageId, deployment: 'API_REPLACED_HEALTH_AND_REAL_DATA_NOT_VERIFIED'};
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), mode = args[0]?.startsWith('--') ? 'preflight' : args.shift() ?? 'preflight';
    const options = {}, files = [];
    const allowed = mode === 'inspect' ? ['--endpoint', '--project', '--file', '--env-file', '--api-origin', '--output']
      : ['--binding', '--candidate', '--apply', '--env-file'];
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      must(allowed.includes(key) && (key === '--file' || !Object.hasOwn(options, key)), 'Unknown or repeated guard option');
      const value = key === '--apply' ? true : args[++i];
      must(value === true || (typeof value === 'string' && value.length > 0 && !value.startsWith('--')), 'Missing guard option value');
      if (key === '--file') files.push(resolve(value)); else options[key] = value;
    }
    if (mode === 'inspect') {
      must(options['--output'] && options['--env-file'], 'Use inspect --endpoint unix:///...sock --project NAME --file COMPOSE --env-file ENV --api-origin HTTPS_ORIGIN --output FRESH_FILE');
      const proposal = await discoverBinding({endpoint: options['--endpoint'], project: options['--project'], files,
        envFile: resolve(options['--env-file']), apiOrigin: options['--api-origin']});
      await writeFile(resolve(options['--output']), `${JSON.stringify(proposal, null, 2)}\n`, {flag: 'wx', mode: 0o600});
      console.log('UNREVIEWED: proposal written; compare with independently retained deployment and backup receipts before owner review.');
    } else {
      must(['preflight', 'backup-check', 'apply'].includes(mode) && options['--binding'], 'Use preflight|backup-check|apply --binding FILE [--candidate FILE] [--apply]');
      must(!options['--apply'] || mode === 'apply', '--apply is only valid for the apply command');
      must(mode !== 'backup-check' || (!options['--candidate'] && options['--env-file']), 'Backup check requires its exact env-file and no candidate');
      must(!options['--env-file'] || mode === 'backup-check', '--env-file is only accepted by inspect/backup-check');
      const reload = async () => ({binding: json(await regularFile(resolve(options['--binding'])), 'binding'),
        candidate: options['--candidate'] ? json(await regularFile(resolve(options['--candidate'])), 'candidate receipt') : undefined});
      const initial = await reload();
      if (mode === 'backup-check') same(resolve(options['--env-file']), initial.binding.compose.envFile, 'Backup env-file');
      const receipt = mode === 'apply' ? await applyCandidate({...initial, confirmed: options['--apply'] === true, reload})
        : (await preflight(initial)).receipt;
      if (mode === 'backup-check') console.log([receipt.apiId, receipt.dbId, receipt.apiImage, receipt.photoVolume, receipt.bindingSha256, receipt.endpoint, receipt.databaseFingerprint].join('|'));
      else console.log(JSON.stringify(receipt));
    }
  } catch (error) { console.error(`Deployment guard blocked: ${error.message}`); process.exitCode = 1; }
}

// Synthetic test values only. Never accepts a real daemon or deployment file.
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest, sourceLabels} from '../build-api-candidate.mjs';

export async function deploymentFixture() {
  const root = await mkdtemp(join(tmpdir(), 'medbox-guard-unit-'));
  const project = 'medbox-synthetic';
  const apiId = 'a'.repeat(64), dbId = 'b'.repeat(64), oldImage = `sha256:${'c'.repeat(64)}`;
  const networkId = 'd'.repeat(64), candidateImage = `sha256:${'e'.repeat(64)}`;
  const migrations = [{name: '001_synthetic.sql', checksum: 'f'.repeat(64)}];
  const database = {systemIdentifier: '12345678901234567', name: 'syntheticdb', user: 'syntheticdb', oid: '16384', schema: 'public', schemas: ['public'],
    migrationsSha256: digest(JSON.stringify(migrations)), migrationCount: 1};
  const volume = name => ({name, created: '2026-01-01T00:00:00Z', mountpoint: `/synthetic/${name}`, driver: 'local', scope: 'local', labels: {'com.docker.compose.project': project}, options: null});
  const volumes = {database: volume(`${project}_db`), photos: volume(`${project}_photos`)};
  const network = {id: networkId, name: `${project}_default`, driver: 'bridge', internal: true, labels: {'com.docker.compose.project': project}};
  const pg = {PGHOST: 'db', PGPORT: '5432', PGDATABASE: database.name, PGUSER: database.user};
  const mount = (name, destination) => ({Type: 'volume', Name: name, Destination: destination, Source: `/synthetic/${name}`, RW: true});
  const container = (id, image, service, mounts) => ({id, image, state: service === 'api' ? 'exited' : 'running',
    labels: {'com.docker.compose.project': project, 'com.docker.compose.service': service}, mounts,
    networks: {[network.name]: {NetworkID: networkId, Aliases: [service]}}, networkMode: network.name,
    uploadPaths: service === 'api' ? ['PRIVATE_UPLOAD_DIR=/var/lib/medbox/private-uploads', ''] : [''],
    envKeys: service === 'api' ? [...Object.keys(pg), 'PGPASSWORD', ''] : [''],
    safeEnv: service === 'api' ? [...Object.entries(pg).map(([key, value]) => `${key}=${value}`), ''] : ['']});
  const config = {name: project, services: {
    db: {image: 'postgres:17-alpine', environment: {POSTGRES_DB: database.name, POSTGRES_USER: database.user},
      volumes: [{type: 'volume', source: 'database', target: '/var/lib/postgresql/data'}], networks: {default: null}},
    api: {image: oldImage, environment: {...pg, PGPASSWORD: 'synthetic-only-$literal', WECHAT_APP_SECRET: 'synthetic-provider-secret',
      WECHAT_REMINDER_SCHEDULER_ENABLED: 'false', WECHAT_DOSE_REMINDER_SCHEDULER_ENABLED: 'false', LEAFLET_PHOTO_CLEANUP_ENABLED: 'false'},
      volumes: [{type: 'volume', source: 'photos', target: '/var/lib/medbox/private-uploads'}], networks: {default: null}, depends_on: {db: {condition: 'service_healthy'}}, ports: []},
  }, volumes: {database: {name: volumes.database.name}, photos: {name: volumes.photos.name}}, networks: {default: {name: network.name}}};
  const path = join(root, 'compose.json'), envFile = join(root, 'synthetic.env');
  const bytes = JSON.stringify(config);
  await writeFile(path, bytes); await writeFile(envFile, '# synthetic only\n');
  const binding = {schemaVersion: 1, kind: 'MEDBOX_EXISTING_DEPLOYMENT_BINDING',
    review: {status: 'OWNER_REVIEWED', reference: 'Synthetic fixture explicitly created by this test'},
    endpoint: 'unix:///var/run/docker.sock', daemonId: 'synthetic-daemon', project, api: {id: apiId, image: oldImage}, db: {id: dbId, image: oldImage},
    volumes, network, database, apiOrigin: 'https://synthetic.invalid', compose: {files: [{path, sha256: digest(bytes)}], envFile, configSha256: digest(bytes)}};
  const candidate = {schemaVersion: 1, kind: 'MEDBOX_API_CANDIDATE', sourceSha: '1'.repeat(40), sourceTree: '2'.repeat(40), apiTree: '3'.repeat(40),
    imageId: candidateImage, apiOrigin: binding.apiOrigin, migrationsSha256: database.migrationsSha256, migrationCount: 1, provenance: 'LOCAL_BUILD_RECEIPT_NOT_A_SIGNATURE'};
  const state = {daemonId: binding.daemonId, project, apiId, dbId, config,
    containers: {[apiId]: container(apiId, oldImage, 'api', [mount(volumes.photos.name, '/var/lib/medbox/private-uploads')]), [dbId]: container(dbId, oldImage, 'db', [mount(volumes.database.name, '/var/lib/postgresql/data')])},
    volumes: Object.fromEntries(Object.values(volumes).map(v => [v.name, v])), network: {...network, containers: {[dbId]: {Name: 'synthetic-db'}}},
    probe: {systemIdentifier: database.systemIdentifier, name: database.name, user: database.user, oid: database.oid, schema: 'public', schemas: ['public'], migrations, otherClients: 0},
    image: {id: candidateImage, labels: sourceLabels(candidate), command: ['node', 'apps/api/dist/server.js'], entrypoint: ['docker-entrypoint.sh'], envKeys: ['NODE_ENV', 'PATH', 'PRIVATE_UPLOAD_DIR', ''], uploadPaths: ['PRIVATE_UPLOAD_DIR=/var/lib/medbox/private-uploads', '']}};
  return {root, binding, candidate, state, close: () => rm(root, {recursive: true, force: true})};
}

export async function fakeDockerResponse(state, args) {
  if (args[0] === '--host') args = args.slice(2);
  if (args[0] === 'info') return state.daemonId;
  if (args[0] === 'compose' && args.includes('config')) return JSON.stringify(state.config);
  if (args[0] === 'compose' && args.includes('ps')) return args.at(-1) === 'api' ? state.apiId : state.dbId;
  if (args[1] === 'inspect') {
    const found = args[0] === 'container' ? state.containers[args.at(-1)] : args[0] === 'volume' ? state.volumes[args.at(-1)] : args[0] === 'network' ? state.network : state.image;
    if (!found) throw new Error('Synthetic object missing');
    return JSON.stringify(found);
  }
  if (args[0] === 'ps') {
    const target = args.at(-1).replace(/^volume=/, '');
    return Object.values(state.containers).filter(c => c.mounts.some(m => m.Name === target)).map(c => c.id).join('\n');
  }
  if (args[0] === 'exec' || args[0] === 'run') return JSON.stringify(state.probe);
  if (args[0] === 'compose' && args.includes('up')) {
    state.applied = JSON.parse(await readFile(args[args.indexOf('-f') + 1], 'utf8'));
    const replacement = structuredClone(state.containers[state.apiId]);
    replacement.id = '9'.repeat(64); replacement.image = state.image.id; replacement.state = 'running';
    delete state.containers[state.apiId]; state.apiId = replacement.id; state.containers[replacement.id] = replacement;
    return '';
  }
  throw new Error(`Unexpected synthetic Docker operation: ${args[0]} ${args[1]}`);
}

export function fakeDocker(state) {
  const calls = [];
  const docker = async args => { calls.push([...args]); return {stdout: await fakeDockerResponse(state, args)}; };
  return {docker, calls};
}

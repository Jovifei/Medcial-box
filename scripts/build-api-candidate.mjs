// Build only from a fixed Git archive. The receipt is local provenance, not a signature.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const repositoryUrl = 'https://github.com/Jovifei/Medcial-box';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const sourceLabels = source => ({
  'org.opencontainers.image.source': repositoryUrl,
  'org.opencontainers.image.revision': source.sourceSha,
  'io.medbox.source-tree': source.sourceTree,
  'io.medbox.api-tree': source.apiTree,
});

export function command(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => execFile(file, args,
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600_000, ...options},
    (error, stdout, stderr) => error ? reject(error) : resolvePromise({stdout, stderr})));
}

export async function sourceIdentity(root, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('An exact 40-hex source SHA is required');
  const git = async args => (await command('git', args, {cwd: root})).stdout.trim();
  if (await git(['rev-parse', `${sha}^{commit}`]) !== sha) throw new Error('Source commit mismatch');
  const names = (await git(['ls-tree', '--name-only', sha, 'apps/api/db/migrations/'])).split('\n').filter(Boolean).sort();
  const migrations = [];
  for (const path of names) {
    if (!/^apps\/api\/db\/migrations\/\d+_[a-z0-9_-]+\.sql$/i.test(path)) throw new Error('Unexpected migration path');
    const bytes = (await command('git', ['show', `${sha}:${path}`], {cwd: root})).stdout.replace(/\r\n/g, '\n');
    migrations.push({name: path.split('/').at(-1), checksum: digest(bytes)});
  }
  if (!migrations.length) throw new Error('Missing candidate migration ledger');
  return {
    sourceSha: sha, sourceTree: await git(['rev-parse', `${sha}^{tree}`]),
    apiTree: await git(['rev-parse', `${sha}:apps/api`]),
    migrationsSha256: digest(JSON.stringify(migrations)), migrationCount: migrations.length,
  };
}

export async function buildApiCandidate({root, sha, tag, apiOrigin, output, docker}) {
  if (!/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_.-]+$/.test(tag ?? '')) throw new Error('An explicit local candidate image tag is required');
  const origin = new URL(apiOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== apiOrigin || origin.username || origin.password) throw new Error('An exact HTTPS API origin is required');
  const source = await sourceIdentity(root, sha);
  const temporary = await mkdtemp(join(tmpdir(), 'medbox-api-build-'));
  try {
    const config = join(temporary, 'docker-config');
    await mkdir(config, {mode: 0o700});
    docker ??= args => command('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      env: {PATH: process.env.PATH, DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: config},
    });
    const tags = (await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).stdout.trim().split('\n');
    if (tags.includes(tag)) throw new Error('Candidate tag already exists; use a fresh tag');
    const context = join(temporary, 'source');
    await mkdir(context);
    await command('git', ['archive', '--format=tar', `--output=${join(temporary, 'source.tar')}`, sha], {cwd: root});
    await command('tar', ['-xf', join(temporary, 'source.tar'), '-C', context]);
    await docker(['build', '--tag', tag, '--file', join(context, 'apps/api/Dockerfile'),
      '--build-arg', `MEDBOX_SOURCE_SHA=${source.sourceSha}`, '--build-arg', `MEDBOX_SOURCE_TREE=${source.sourceTree}`,
      '--build-arg', `MEDBOX_API_TREE=${source.apiTree}`, context]);
    const inspected = JSON.parse((await docker(['image', 'inspect', '--format', '{{json .}}', tag])).stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(inspected.Id ?? '')) throw new Error('Invalid built image identity');
    for (const [key, value] of Object.entries(sourceLabels(source))) {
      if (inspected.Config?.Labels?.[key] !== value) throw new Error(`Candidate image source label mismatch: ${key}`);
    }
    const receipt = {schemaVersion: 1, kind: 'MEDBOX_API_CANDIDATE', ...source,
      imageId: inspected.Id, apiOrigin, provenance: 'LOCAL_BUILD_RECEIPT_NOT_A_SIGNATURE'};
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx', mode: 0o600});
    return receipt;
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const option = key => args[args.indexOf(key) + 1];
    if (args.length !== 8 || !['--sha', '--tag', '--api-origin', '--output'].every(key => args.indexOf(key) >= 0)) throw new Error('Use --sha SHA --tag TAG --api-origin HTTPS_ORIGIN --output FRESH_RECEIPT');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const receipt = await buildApiCandidate({root, sha: option('--sha'), tag: option('--tag'), apiOrigin: option('--api-origin'), output: option('--output')});
    console.log(JSON.stringify(receipt));
  } catch { console.error('API candidate build failed; no deployment was performed. Inspect local build/tool availability without publishing private output.'); process.exitCode = 1; }
}

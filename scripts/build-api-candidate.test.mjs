import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApiCandidate, sourceIdentity, sourceLabels, command, digest} from './build-api-candidate.mjs';

test('candidate build uses exact Git bytes despite a dirty checkout and binds source labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medbox-build-source-'));
  try {
    await mkdir(join(root, 'apps/api/db/migrations'), {recursive: true});
    const sql = 'SELECT 1;\n';
    await writeFile(join(root, 'apps/api/db/migrations/001_synthetic.sql'), sql);
    await writeFile(join(root, 'apps/api/Dockerfile'), '# Synthetic build adapter\n');
    const git = args => command('git', args, {cwd: root});
    await git(['init', '--quiet']); await git(['add', '.']);
    await git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', '合成固定源码']);
    const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const source = await sourceIdentity(root, sha);
    assert.equal(source.migrationsSha256, digest(JSON.stringify([{name: '001_synthetic.sql', checksum: digest(sql)}])));
    await writeFile(join(root, 'apps/api/db/migrations/001_synthetic.sql'), 'DIRTY CHECKOUT MUST NOT BUILD');
    const calls = [], imageId = `sha256:${'a'.repeat(64)}`;
    const docker = async args => {
      calls.push(args);
      if (args[0] === 'build') {
        assert.equal(await readFile(join(args.at(-1), 'apps/api/db/migrations/001_synthetic.sql'), 'utf8'), sql);
        for (const [key, value] of [['SHA', source.sourceSha], ['TREE', source.sourceTree], ['API_TREE', source.apiTree]]) {
          const name = key === 'API_TREE' ? 'MEDBOX_API_TREE' : `MEDBOX_SOURCE_${key}`;
          assert(args.includes(`${name}=${value}`));
        }
      }
      return {stdout: args.includes('inspect') ? JSON.stringify({Id: imageId, Config: {Labels: sourceLabels(source)}}) : ''};
    };
    const output = join(root, 'candidate.json');
    const candidate = await buildApiCandidate({root, sha, tag: 'synthetic:fixed', apiOrigin: 'https://synthetic.invalid', output, docker});
    assert.equal(candidate.sourceSha, sha); assert.equal(candidate.imageId, imageId);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), candidate);
    assert.equal(calls.filter(args => args[0] === 'build').length, 1);
    await assert.rejects(buildApiCandidate({root, sha, tag: 'synthetic:fixed', apiOrigin: 'https://synthetic.invalid', output,
      docker: async args => ({stdout: args.includes('ls') ? 'synthetic:fixed\n' : ''})}), /already exists/);
    await assert.rejects(buildApiCandidate({root, sha, tag: 'synthetic:wrong-source', apiOrigin: 'https://synthetic.invalid', output: join(root, 'bad.json'),
      docker: async args => ({stdout: args.includes('inspect') ? JSON.stringify({Id: imageId, Config: {Labels: {}}}) : ''})}), /source label mismatch/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

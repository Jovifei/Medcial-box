import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkClientVersions } from './check-client-versions.mjs';

test('候选版本必须同时匹配微信、Android构建号及显示版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'medbox-version-'));
  const paths = [
    'VERSION.json', 'apps/miniprogram/services/app-update.ts',
    'apps/flutter/pubspec.yaml', 'apps/flutter/lib/features/my/release_notes_page.dart',
  ];
  const directories = ['apps', 'apps/miniprogram', 'apps/miniprogram/services',
    'apps/flutter', 'apps/flutter/lib', 'apps/flutter/lib/features', 'apps/flutter/lib/features/my'];
  try {
    for (const directory of directories) await mkdir(join(root, directory));
    await writeFile(join(root, paths[0]), JSON.stringify({ version: '1.2.3', androidBuild: 8, channel: 'candidate' }));
    await writeFile(join(root, paths[1]), 'export const APP_VERSION = "1.2.3";');
    await writeFile(join(root, paths[2]), 'version: 1.2.3+8\n');
    await writeFile(join(root, paths[3]), "const String appVersion = '1.2.3';");
    assert.equal((await checkClientVersions(root)).version, '1.2.3');
    for (const [path, wrong, correct] of [
      [paths[1], 'export const APP_VERSION = "1.2.2";', 'export const APP_VERSION = "1.2.3";'],
      [paths[2], 'version: 1.2.3+7\n', 'version: 1.2.3+8\n'],
      [paths[3], "const String appVersion = '1.2.2';", "const String appVersion = '1.2.3';"],
    ]) {
      await writeFile(join(root, path), wrong);
      await assert.rejects(checkClientVersions(root), /不一致/);
      await writeFile(join(root, path), correct);
    }
    await writeFile(join(root, paths[1]), '// export const APP_VERSION = "1.2.3";\nexport const APP_VERSION = "1.2.2";');
    await assert.rejects(checkClientVersions(root), /不一致/);
    await writeFile(join(root, paths[1]), 'export const APP_VERSION = "1.2.3";');
    await writeFile(join(root, paths[3]), "// const String appVersion = '1.2.3';\nconst String appVersion = '1.2.2';");
    await assert.rejects(checkClientVersions(root), /不一致/);
    await writeFile(join(root, paths[3]), "const String appVersion = '1.2.3';");
    for (const androidBuild of [-1, 0, 1.5, 2100000001]) {
      await writeFile(join(root, paths[0]), JSON.stringify({ version: '1.2.3', androidBuild, channel: 'candidate' }));
      await assert.rejects(checkClientVersions(root), /无效/);
    }
  } finally {
    // Remove only exact files/directories this test created; never recursive cleanup.
    for (const path of paths) await unlink(join(root, path)).catch(() => {});
    for (const directory of directories.reverse()) await rmdir(join(root, directory));
    await rmdir(root);
  }
});

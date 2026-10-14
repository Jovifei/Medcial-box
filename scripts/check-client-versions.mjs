import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('..', import.meta.url));

// Source metadata consistency only; this does not approve a deployment or install.
export async function checkClientVersions(root = workspace) {
  const read = path => readFile(resolve(root, path), 'utf8');
  const metadata = JSON.parse(await read('VERSION.json'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) ||
      !Number.isSafeInteger(metadata.androidBuild) || metadata.androidBuild <= 0 || metadata.androidBuild > 2100000000 ||
      !['candidate', 'release'].includes(metadata.channel)) {
    throw new Error('VERSION.json 版本或构建号无效');
  }
  const mini = (await read('apps/miniprogram/services/app-update.ts'))
    .match(/^export const APP_VERSION = "([^"]+)";\s*$/m)?.[1];
  const android = (await read('apps/flutter/pubspec.yaml'))
    .match(/^version:\s*(\S+)\s*$/m)?.[1];
  const displayed = (await read('apps/flutter/lib/features/my/release_notes_page.dart'))
    .match(/^const String appVersion = '([^']+)';\s*$/m)?.[1];
  if (mini !== metadata.version || displayed !== metadata.version ||
      android !== `${metadata.version}+${metadata.androidBuild}`) {
    throw new Error('客户端版本与 VERSION.json 不一致，禁止形成发布候选');
  }
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const metadata = await checkClientVersions();
    console.info(`版本一致：${metadata.version}，Android ${metadata.androidBuild}（仅源码元数据）`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

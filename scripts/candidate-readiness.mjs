// Offline engineering-candidate intake; does not grant platform/production release.
// Signed platform receipts and human verification are deliberately out of scope.
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exactSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const exactDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const unverifiedStages = Object.freeze({
  sourcePackage: 'PASS',
  wechatCompile: 'NOT_RUN',
  wechatUpload: 'NOT_RUN',
  realDevice: 'NOT_RUN',
  androidInstall: 'NOT_RUN',
  deployment: 'NOT_PERFORMED',
  formalRelease: 'NOT_AUTHORIZED',
});
const prerequisites = ['verify', 'backup-docker', 'flutter'];
const must = (ok, message) => { if (!ok) throw new Error(message); };
const equalStages = value => object(value) &&
  Object.keys(value).sort().join('|') === Object.keys(unverifiedStages).sort().join('|') &&
  Object.entries(unverifiedStages).every(([key, state]) => value[key] === state);

export function assessCandidateReadiness(manifest, receipt) {
  must(object(manifest) && manifest.schemaVersion === 1 &&
    manifest.kind === 'MEDBOX_SOURCE_CANDIDATE', 'Invalid candidate manifest');
  must(exactSha(manifest.sourceSha) && exactSha(manifest.sourceTree) &&
    exactSha(manifest.miniTree) && exactDigest(manifest.packageSha256),
    'Invalid candidate source digest');
  must(object(manifest.version) && /^\d+\.\d+\.\d+$/.test(manifest.version.version) &&
    manifest.version.channel === 'candidate' &&
    Number.isSafeInteger(manifest.version.androidBuild) &&
    manifest.version.androidBuild > 0, 'Wrong candidate version');
  must(object(manifest.client) &&
    manifest.client.appId === 'wx1f6dd99d28aab8e5' &&
    manifest.client.apiBase === 'https://medbox.joviluma.com',
    'Unexpected candidate public client configuration');
  must(object(manifest.files) && Object.keys(manifest.files).length > 0 &&
    Object.values(manifest.files).every(value =>
      object(value) && exactDigest(value.sha256) &&
      Number.isSafeInteger(value.bytes) && value.bytes >= 0),
    'Missing or malformed source file hashes');
  must(equalStages(manifest.stages), 'Platform/deployment stage falsely claimed in manifest');
  must(object(receipt) && receipt.schemaVersion === 1 &&
    receipt.sourceSha === manifest.sourceSha &&
    receipt.repository === 'Jovifei/Medcial-box' &&
    /^[1-9][0-9]*$/.test(String(receipt.runId)) &&
    Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0,
    'Candidate and CI identity mismatch');
  must(receipt.attestation === 'UNSIGNED_CI_RECEIPT_NOT_A_SIGNATURE' &&
    receipt.workflowConclusion === 'CHECK_GITHUB_AFTER_RUN_COMPLETES',
    'Unsupported CI attestation or claimed conclusion');
  must(object(receipt.prerequisites) &&
    Object.keys(receipt.prerequisites).sort().join('|') === prerequisites.slice().sort().join('|') &&
    prerequisites.every(key => receipt.prerequisites[key] === 'success'),
    'CI prerequisite is missing or unsuccessful');
  must(equalStages(receipt.stages), 'Platform/deployment stage falsely claimed in receipt');
  return {
    schemaVersion: 1,
    kind: 'MEDBOX_106_ENGINEERING_INTAKE',
    sourceSha: manifest.sourceSha,
    sourceTree: manifest.sourceTree,
    miniTree: manifest.miniTree,
    packageSha256: manifest.packageSha256,
    version: manifest.version.version,
    androidBuild: manifest.version.androidBuild,
    publicClient: manifest.client,
    ci: { repository: receipt.repository, runId: String(receipt.runId),
      attempt: receipt.attempt,
      claimedPrerequisites: Object.fromEntries(prerequisites.map(key => [key, 'success'])),
      independentGitHubRunVerification: 'REQUIRED',
      signature: 'NONE' },
    status: 'ENGINEERING_CANDIDATE_ONLY',
    stages: { ...unverifiedStages },
    releaseAllowed: false,
    reasons: [
      'CI receipt is unsigned and not independently authoritative',
      'WeChat official compile/upload and real two-household device acceptance are not verified',
      'Current production API and family data were not touched',
      'Android candidate has no distribution signing or install acceptance',
      'Formal release requires explicit separate owner approval',
    ],
  };
}

async function readBoundedRegularJson(path) {
  const stat = await lstat(path);
  must(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 512 * 1024,
    'Input must be a regular JSON file within 512 KiB');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function writeReadiness({ manifestPath, receiptPath, outputPath }) {
  must(manifestPath && receiptPath && outputPath, 'Manifest, receipt and fresh output are required');
  const result = assessCandidateReadiness(
    await readBoundedRegularJson(manifestPath),
    await readBoundedRegularJson(receiptPath),
  );
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  // Never silently overwrite a previous SHA/CI receipt.
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = option => { const i = args.indexOf(option); return i < 0 ? undefined : args[i + 1]; };
  try {
    console.info(JSON.stringify(await writeReadiness({
      manifestPath: value('--manifest'),
      receiptPath: value('--receipt'),
      outputPath: value('--output'),
    }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Readiness gate failed');
    process.exitCode = 1;
  }
}

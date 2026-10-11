// Artifact verifier shared by the existing upgrade and isolated backup runners.
// Files are machine-produced synthetic evidence, never production acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function candidateAt(root = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding:'utf8'}).trim();
  const sha = git('rev-parse','HEAD');
  return {sha, rootTree:git('rev-parse',`${sha}^{tree}`), miniTree:git('rev-parse',`${sha}:apps/miniprogram`)};
}
export function verifyEvidence(file, {restore = false, root = process.cwd()} = {}) {
  const evidence = JSON.parse(readFileSync(file));
  assert.deepEqual(evidence.candidate, candidateAt(root), 'candidate must match this checkout, root and mini trees');
  assert.equal(evidence.layer, 'SYNTHETIC', 'production/device evidence cannot be qualified by this verifier');
  const base = dirname(resolve(file));
  const readArtifact = entry => {
    assert(entry && typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), 'missing artifact path/hash');
    const path = resolve(base, entry.path);
    const rel = relative(base,path);
    assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'artifact escapes evidence directory');
    assert(statSync(path).isFile(), 'artifact is not a file');
    const bytes = readFileSync(path);
    assert(bytes.length > 0, 'empty artifact');
    assert.equal(hash(bytes),entry.sha256,'artifact byte checksum mismatch');
    return bytes;
  };
  const before = JSON.parse(readArtifact(evidence.before));
  const after = JSON.parse(readArtifact(evidence.after));
  const tables = ['families','members','medicines','batches','photos','drafts','plans','reminders'];
  for (const snapshot of [before,after]) {
    for (const table of tables) assert(Array.isArray(snapshot[table]), `missing ${table}`);
    for (const table of ['families','members','medicines','photos']) assert(snapshot[table].length > 0, `empty ${table}`);
  }
  // Compare every field, including ownership/content, rather than IDs alone.
  for (const table of tables) {
    const sorted = rows => [...rows].sort((a,b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(sorted(after[table]),sorted(before[table]), `${table} content or ownership lost`);
    assert.equal(new Set(after[table].map(row=>row.id)).size, after[table].length, `duplicate ${table} id`);
  }
  for (const photo of after.photos) {
    assert(after.medicines.some(m=>m.id===photo.medicine_id && m.family_id===photo.family_id), 'photo household/medicine association mismatch');
    const artifact = evidence.photos?.find(item=>item.id===photo.id && item.storageKey===photo.storage_key);
    assert(artifact, 'missing restored photo artifact');
    assert.equal(readArtifact(artifact).length, photo.size_bytes, 'photo size mismatch');
  }
  assert.equal(evidence.photos?.length,after.photos.length,'photo cardinality mismatch');
  if (restore) {
    readArtifact(evidence.backupDatabase); readArtifact(evidence.backupPhotos);
    assert(/^sha256:[a-f0-9]{64}$/.test(evidence.buildImage), 'missing actual build image digest');
  }
  return {candidate:evidence.candidate, layer:evidence.layer, records:after.medicines.length, photos:after.photos.length, device:'NOT_RUN', production:'NOT_RUN'};
}

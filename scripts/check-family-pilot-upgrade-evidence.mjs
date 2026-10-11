import { verifyEvidence } from './family-pilot-evidence.mjs';
try {
  if (!process.argv[2]) throw new Error('upgrade evidence file required');
  console.log(JSON.stringify(verifyEvidence(process.argv[2]), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }

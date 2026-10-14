import fs from "node:fs";

const file = process.argv[2] ?? "docs/operations/family-pilot-manifest.example.json";
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));

const required = [
  manifest.stage === "family-pilot",
  manifest.release?.mergeAllowed === false,
  manifest.release?.productionDeployment === false,
  manifest.secrets?.valuesIncluded === false,
  manifest.requiredChecks?.databaseBackupRestore === true,
  manifest.requiredChecks?.privatePhotoRestorePairing === true,
];

if (!required.every(Boolean)) {
  console.error("family pilot manifest contract failed");
  process.exit(1);
}

console.log(JSON.stringify({
  scope: "SOURCE_ONLY",
  sourceContract: "PASS",
  databaseBackupRestore: "NOT_RUN",
  privatePhotoRestorePairing: "NOT_RUN",
  deviceAcceptance: "NOT_RUN",
  productionRestore: "NOT_RUN",
  detail: "Required-check declarations are configuration only; use generated artifacts and the isolated restore runner for execution evidence.",
}, null, 2));

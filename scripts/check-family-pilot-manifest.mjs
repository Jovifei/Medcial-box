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

console.log("family pilot manifest contract PASS");

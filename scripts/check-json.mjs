import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skippedDirectories = new Set([".git", "node_modules", "dist", "compiled"]);
const failures = [];

async function inspect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(path);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        failures.push(`${relative(root, path)}: ${String(error)}`);
      }
    }
  }
}

await inspect(root);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.info("JSON syntax check passed.");
}

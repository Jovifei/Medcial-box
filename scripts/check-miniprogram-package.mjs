// Conservative source-package budget; DevTools upload remains the final package check.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function checkMiniProgramPackage(root) {
  const json = async (name) => JSON.parse(await readFile(join(root, name), "utf8"));
  const [project, app] = await Promise.all([json("project.config.json"), json("app.json")]);
  const sitemap = await json(app.sitemapLocation ?? "sitemap.json");
  const errors = [];
  if (!Array.isArray(sitemap.rules) || !sitemap.rules.length ||
      !sitemap.rules.some((rule) => rule.action === "disallow" && rule.page === "*")) {
    errors.push("sitemap must explicitly disallow private pages with a nonempty rules array");
  }
  if (project.setting?.minified !== true) errors.push("JS minification must be enabled");
  if (project.setting?.uploadWithSourceMap !== false) errors.push("upload source maps must be disabled");
  if (app.lazyCodeLoading !== "requiredComponents") errors.push("lazyCodeLoading must be requiredComponents");
  const ignores = project.packOptions?.ignore ?? [];
  const ignored = (relative) => ignores.some(({ type, value }) =>
    type === "folder" ? relative === value || relative.startsWith(`${value}/`) : type === "file" && relative === value);
  let bytes = 0;
  let files = 0;
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (ignored(relative)) continue;
      if (entry.isSymbolicLink()) { errors.push(`symlink cannot be packaged: ${relative}`); continue; }
      if (entry.isDirectory()) { await walk(join(directory, entry.name), `${relative}/`); continue; }
      // DevTools configuration itself is not runtime package content.
      if (["project.config.json", "project.private.config.json"].includes(relative)) continue;
      const size = (await stat(join(directory, entry.name))).size;
      bytes += size;
      files++;
      if (/\.(png|jpe?g|gif|webp|svg|mp3|wav|m4a|aac|ogg)$/i.test(relative) && size > 200 * 1024) {
        errors.push(`media exceeds 200 KiB: ${relative} (${size} bytes)`);
      }
      if (/(^|\/)(test|typings|node_modules)(\/|$)|\.map$|(^|\/)\.env(?:\.|$)/.test(relative)) {
        errors.push(`development or secret file included: ${relative}`);
      }
    }
  }
  await walk(root);
  if (bytes > 1.5 * 1024 * 1024) errors.push(`main package exceeds 1.5 MiB source budget: ${bytes} bytes`);
  return { ok: errors.length === 0, bytes, files, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkMiniProgramPackage(resolve(process.argv[2] ?? "apps/miniprogram"));
  console.info(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

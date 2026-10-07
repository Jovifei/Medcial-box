// Conservative mini-program package gate. Source mode checks repository hygiene;
// release mode additionally requires a generated HTTPS client project.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function releaseApiError(configText) {
  const match = /export\s+const\s+API_BASE\s*=\s*(["'])(.*?)\1\s*;?/.exec(configText);
  if (!match) return "release package must contain one static API_BASE origin";
  let url;
  try { url = new URL(match[2]); } catch { return "release API_BASE must be a valid URL"; }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" || loopback || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    return "release API_BASE must be a credential-free public HTTPS origin";
  }
  return null;
}

export async function checkMiniProgramPackage(root, { mode = "release" } = {}) {
  if (!["release", "source"].includes(mode)) throw new Error("mode must be release or source");
  const json = async (name) => JSON.parse(await readFile(join(root, name), "utf8"));
  const [project, app] = await Promise.all([json("project.config.json"), json("app.json")]);
  const sitemap = await json(app.sitemapLocation ?? "sitemap.json");
  const errors = [];

  if (project.appid === "touristappid" || /^QA-ONLY-/.test(project.projectname ?? "")) {
    errors.push("QA-only build must never be uploaded or released");
  }
  if (mode === "release") {
    if (!/^wx[0-9a-f]{16}$/i.test(project.appid ?? "")) {
      errors.push("release package must use an approved mini-program AppID");
    }
    if (project.setting?.urlCheck !== true) {
      errors.push("release package must keep WeChat domain validation enabled");
    }
    if (project.libVersion === "trial") {
      errors.push("release package must not use the trial mini-program base library");
    }
    if (/源码.*禁止上传/.test(project.projectname ?? "")) {
      errors.push("source project is not a release artifact; generate an isolated HTTPS package first");
    }
    if (/本机试用/.test(project.projectname ?? "")) {
      errors.push("local-trial project must never be uploaded or released");
    }
    try {
      const configText = await readFile(join(root, "services", "config.ts"), "utf8");
      const apiError = releaseApiError(configText);
      if (apiError) errors.push(apiError);
    } catch {
      errors.push("release package is missing services/config.ts");
    }
  }

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
      if (["project.config.json", "project.private.config.json"].includes(relative)) continue;
      if (/QA-DO-NOT-UPLOAD|^qa\//.test(relative)) errors.push(`QA-only fixture file cannot be released: ${relative}`);
      if (/\.(js|ts|json)$/.test(relative) && (await readFile(join(directory, entry.name), "utf8")).includes("MEDICINE_QA_ONLY")) {
        errors.push(`QA build mark cannot be released: ${relative}`);
      }
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
  return { ok: errors.length === 0, mode, bytes, files, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args.includes("--source") ? "source" : "release";
  const path = args.find((arg) => !arg.startsWith("--")) ?? "apps/miniprogram";
  const result = await checkMiniProgramPackage(resolve(path), { mode });
  console.info(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

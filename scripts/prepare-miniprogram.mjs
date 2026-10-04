// Generate an isolated DevTools project; never alter the source AppID/base URL.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const workspace = fileURLToPath(new URL("..", import.meta.url));

export function validateClientConfig(appId, apiBase, { local = false } = {}) {
  if (!/^wx[0-9a-f]{16}$/i.test(appId ?? "")) {
    throw new Error("Pass the real AppID (wx + 16 hexadecimal characters).");
  }
  const url = new URL(apiBase);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((local ? url.protocol !== "http:" || !loopback : url.protocol !== "https:" || loopback) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(local
      ? "Local API base must be a credential-free HTTP loopback origin."
      : "API base must be a credential-free HTTPS origin, without a path/query/fragment.");
  }
  return { appId, apiBase: url.origin };
}

export async function prepareMiniProgram({ appId, apiBase, root = workspace, local = false }) {
  const config = validateClientConfig(appId, apiBase, { local });
  const source = join(root, "apps", "miniprogram");
  const output = join(root, ".local-data", `mini-${local ? "local" : "staging"}-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const excluded = new Set(["node_modules", "dist", "compiled", "private.config.json", "project.private.config.json"]);
  await cp(source, output, {
    recursive: true,
    filter(path) {
      const name = basename(path);
      return !excluded.has(name) && !name.startsWith(".") && !name.endsWith(".env");
    },
  });
  const project = JSON.parse(await readFile(join(output, "project.config.json"), "utf8"));
  project.appid = config.appId;
  project.projectname = local ? "JF小药箱-本机试用" : "JF小药箱-测试环境";
  project.setting = { ...project.setting, urlCheck: !local };
  await writeFile(join(output, "project.config.json"), JSON.stringify(project, null, 2) + "\n");
  await writeFile(join(output, "services", "config.ts"),
    `// Generated public client configuration; contains no server secrets.\nexport const API_BASE = ${JSON.stringify(config.apiBase)};\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  try {
    console.info(await prepareMiniProgram({ appId: value("--appid"), apiBase: value("--api-base"),
      local: args.includes("--local") }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to prepare mini program");
    process.exitCode = 1;
  }
}

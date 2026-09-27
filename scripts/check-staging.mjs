import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateStagingEnvironment(env) {
  const password = env.POSTGRES_PASSWORD ?? "";
  if (password.length < 20 || password === "local-dev-only" || /[\r\n]/.test(password)) {
    throw new Error("POSTGRES_PASSWORD must be a distinct, single-line password of at least 20 characters.");
  }
  if (!/^wx[0-9a-f]{16}$/i.test(env.WECHAT_APP_ID ?? "")) {
    throw new Error("WECHAT_APP_ID must be the approved mini-program AppID.");
  }
  if ((env.WECHAT_APP_SECRET ?? "").length < 16) {
    throw new Error("Inject WECHAT_APP_SECRET on the server before starting staging.");
  }
  const port = Number(env.STAGING_API_PORT ?? "3301");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("STAGING_API_PORT must be an unprivileged TCP port.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf("--env-file");
    const path = index >= 0 ? process.argv[index + 1] : "deploy/.env.staging";
    const env = { ...parseEnv(await readFile(path, "utf8")), ...process.env };
    validateStagingEnvironment(env);
    console.info("Staging environment format verified; secret values are not printed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Staging configuration is incomplete");
    process.exitCode = 1;
  }
}

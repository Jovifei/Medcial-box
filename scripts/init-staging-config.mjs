#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(root, "deploy/.env.staging");
const projectPath = resolve(root, "apps/miniprogram/project.config.json");
const MANAGED_KEYS = ["POSTGRES_PASSWORD", "WECHAT_APP_ID", "WECHAT_APP_SECRET"];

export function mergeManagedStagingEnv(existingText, managed) {
  const seen = new Set();
  const output = [];
  const source = existingText === ""
    ? ["# 本地部署配置；文件已被 Git 忽略。服务器副本请设置仅管理员可读权限。"]
    : existingText.replace(/\r\n/g, "\n").split("\n");

  for (const line of source) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key && MANAGED_KEYS.includes(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(`${key}=${managed[key] ?? ""}`);
      continue;
    }
    output.push(line);
  }

  for (const key of MANAGED_KEYS) {
    if (!seen.has(key)) output.push(`${key}=${managed[key] ?? ""}`);
  }

  while (output.length > 0 && output.at(-1) === "") output.pop();
  return output.join("\n") + "\n";
}

export async function initializeStagingConfig({
  targetPath = configPath,
  miniProjectPath = projectPath,
} = {}) {
  const project = JSON.parse(await readFile(miniProjectPath, "utf8"));
  const appId = project.appid;
  if (typeof appId !== "string" || !/^wx[0-9a-f]{16}$/i.test(appId)) {
    throw new Error("项目配置里的小程序 AppID 不正确。");
  }

  let previousText = "";
  let previous = {};
  try {
    previousText = await readFile(targetPath, "utf8");
    previous = parseEnv(previousText);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (previous.WECHAT_APP_ID && previous.WECHAT_APP_ID !== appId) {
    throw new Error("部署配置中的 AppID 与当前项目不一致；为避免替换错误账号，未修改文件。");
  }

  const managed = {
    POSTGRES_PASSWORD: previous.POSTGRES_PASSWORD || randomBytes(24).toString("hex"),
    WECHAT_APP_ID: appId,
    WECHAT_APP_SECRET: previous.WECHAT_APP_SECRET || "",
  };
  const contents = mergeManagedStagingEnv(previousText, managed);
  await writeFile(targetPath, contents, { encoding: "utf8", mode: 0o600 });
  return targetPath;
}

async function main() {
  const target = await initializeStagingConfig();
  console.log("部署配置已准备：数据库密码自动生成，AppID 从项目读取；既有可选部署参数保持不变。");
  console.log(`配置文件：${target.replace(root, ".")}（不会显示或输出密钥值）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "无法初始化部署配置。");
    process.exitCode = 1;
  });
}

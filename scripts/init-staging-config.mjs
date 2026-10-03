#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(root, "deploy/.env.staging");
const projectPath = resolve(root, "apps/miniprogram/project.config.json");

try {
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  const appId = project.appid;
  if (typeof appId !== "string" || !/^wx[0-9a-f]{16}$/i.test(appId)) {
    throw new Error("项目配置里的小程序 AppID 不正确。");
  }

  let previous = {};
  try {
    previous = parseEnv(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (previous.WECHAT_APP_ID && previous.WECHAT_APP_ID !== appId) {
    throw new Error("部署配置中的 AppID 与当前项目不一致；为避免替换错误账号，未修改文件。");
  }

  const databasePassword = previous.POSTGRES_PASSWORD || randomBytes(24).toString("hex");
  const appSecret = previous.WECHAT_APP_SECRET || "";
  const contents = [
    "# 本地部署配置；文件已被 Git 忽略。服务器副本请设置仅管理员可读权限。",
    `POSTGRES_PASSWORD=${databasePassword}`,
    `WECHAT_APP_ID=${appId}`,
    `WECHAT_APP_SECRET=${appSecret}`,
    "",
  ].join("\n");

  await writeFile(configPath, contents, { encoding: "utf8", mode: 0o600 });
  console.log("部署配置已准备：数据库密码自动生成，AppID 从项目读取。只需填写 WECHAT_APP_SECRET。");
  console.log("配置文件：deploy/.env.staging（不会显示或输出密钥值）");
} catch (error) {
  console.error(error instanceof Error ? error.message : "无法初始化部署配置。");
  process.exitCode = 1;
}

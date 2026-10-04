#!/usr/bin/env node
/**
 * 本机小程序编译门禁：调用微信开发者工具自带的官方编译器（wcc / wcsc）
 * 按完整依赖分组编译 WXML 与 WXSS，捕获只有真实编译器才能发现的问题
 * （标签闭合、绑定语法、wx:elif 顺序、样式语法等）。
 *
 * 设计取舍：
 * - 找不到开发者工具时打印提示并以 0 退出，避免在没有安装工具的环境里阻塞 CI；
 * - 同类文件一起编译，确保 import/include 依赖可解析；
 * - 该脚本不替代 IDE 预览，只回答"官方编译器能否通过"。
 */
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { checkMiniProgramPackage } from "./check-miniprogram-package.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.join(repoRoot, "apps", "miniprogram");

function findCompilerDir() {
  const roots = [];
  if (process.env.WECHAT_DEVTOOLS_ROOT) roots.push(process.env.WECHAT_DEVTOOLS_ROOT);
  for (const drive of ["C", "D", "E", "F"]) {
    roots.push(`${drive}:\\Program Files (x86)\\Tencent\\微信web开发者工具`);
    roots.push(`${drive}:\\Program Files\\Tencent\\微信web开发者工具`);
    roots.push(`${drive}:\\AI_Tools\\Other\\WeChatDevTools`);
    roots.push(`${drive}:\\WeChatDevTools`);
  }
  for (const root of roots) {
    const base = path.join(root, "resources", "app.asar.unpacked", "node_modules", "wcc-exec");
    if (existsSync(path.join(base, "wcc.exe")) && existsSync(path.join(base, "wcsc.exe"))) return base;
  }
  return null;
}

function collect(directory, extension) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(full, extension));
    else if (entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

const packageResult = await checkMiniProgramPackage(projectRoot);
if (!packageResult.ok) {
  console.error(JSON.stringify(packageResult, null, 2));
  process.exit(1);
}
console.log(`[check:miniprogram] 打包门禁通过：${packageResult.bytes} bytes，${packageResult.files} files。`);
const compilerDir = findCompilerDir();
if (compilerDir === null) {
  console.log("[check:miniprogram] 未找到微信开发者工具，跳过官方编译器校验。");
  console.log("设置 WECHAT_DEVTOOLS_ROOT 指向安装目录即可启用（例如 E:\\AI_Tools\\Other\\WeChatDevTools）。");
  process.exit(process.env.REQUIRE_WECHAT_COMPILER === "1" ? 1 : 0);
}

const wcc = path.join(compilerDir, "wcc.exe");
const wcsc = path.join(compilerDir, "wcsc.exe");

function compile(executable, files, extraArgs) {
  try {
    execFileSync(executable, [...extraArgs, ...files], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (error) {
    const stderr = error.stderr?.toString().trim() ?? "";
    const stdout = error.stdout?.toString().trim() ?? "";
    return (stderr || stdout || error.message).split("\n").slice(0, 4).join(" | ");
  }
}

const groups = [
  { extension: ".wxml", executable: wcc, args: [] },
  { extension: ".wxss", executable: wcsc, args: ["-lc"] },
];
let count = 0;
const failures = [];
for (const group of groups) {
  const files = collect(projectRoot, group.extension).map(file => path.relative(projectRoot, file).replaceAll("\\", "/")).sort();
  count += files.length;
  const failure = compile(group.executable, files, group.args);
  if (failure !== null) failures.push({ file: group.extension, failure });
}
console.log(`[check:miniprogram] 编译 ${count} 个文件，按依赖完整分组。`);
for (const { file, failure } of failures) console.error(`[check:miniprogram] 失败 ${file}: ${failure}`);
process.exit(failures.length ? 1 : 0);

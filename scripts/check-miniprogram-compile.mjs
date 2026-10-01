#!/usr/bin/env node
/**
 * 本机小程序编译门禁：调用微信开发者工具自带的官方编译器（wcc / wcsc）
 * 逐个编译 WXML 与 WXSS，捕获只有真实编译器才能发现的问题
 * （标签闭合、绑定语法、wx:elif 顺序、样式语法等）。
 *
 * 设计取舍：
 * - 找不到开发者工具时打印提示并以 0 退出，避免在没有安装工具的环境里阻塞 CI；
 * - 逐个文件编译而不是整包，便于精确定位到具体页面；
 * - 该脚本不替代 IDE 预览，只回答"官方编译器能否通过"。
 */
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

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

const compilerDir = findCompilerDir();
if (compilerDir === null) {
  console.log("[check:miniprogram] 未找到微信开发者工具，跳过官方编译器校验。");
  console.log("设置 WECHAT_DEVTOOLS_ROOT 指向安装目录即可启用（例如 E:\\AI_Tools\\Other\\WeChatDevTools）。");
  process.exit(0);
}

const wcc = path.join(compilerDir, "wcc.exe");
const wcsc = path.join(compilerDir, "wcsc.exe");

function compile(executable, file, extraArgs) {
  try {
    execFileSync(executable, [...extraArgs, file], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return null;
  } catch (error) {
    const stderr = error.stderr?.toString().trim() ?? "";
    const stdout = error.stdout?.toString().trim() ?? "";
    return (stderr || stdout || error.message).split("\n").slice(0, 4).join(" | ");
  }
}

const targets = [
  ...collect(projectRoot, ".wxml").map((file) => ({ file, executable: wcc, args: [] })),
  ...collect(projectRoot, ".wxss").map((file) => ({ file, executable: wcsc, args: ["-lc"] })),
];

const failures = [];
for (const { file, executable, args } of targets) {
  const failure = compile(executable, file, args);
  if (failure !== null) failures.push({ file: path.relative(repoRoot, file), failure });
}

console.log(`[check:miniprogram] 官方编译器：${compilerDir}`);
console.log(`[check:miniprogram] 编译 ${targets.length} 个文件（WXML ${targets.filter((t) => t.executable === wcc).length}、WXSS ${targets.length - targets.filter((t) => t.executable === wcc).length}）`);
if (failures.length === 0) {
  console.log("[check:miniprogram] 全部通过。");
  process.exit(0);
}
for (const { file, failure } of failures) console.error(`[check:miniprogram] 失败 ${file}: ${failure}`);
console.error(`[check:miniprogram] ${failures.length} 个文件编译失败。`);
process.exit(1);

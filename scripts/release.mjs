#!/usr/bin/env node
/**
 * Maestro Mobile 发布脚本
 *
 * 用法:
 *   node scripts/release.mjs patch|minor|major [--yes]   递进版本并发布
 *   node scripts/release.mjs --changelog-only            只从 commit 重新生成 CHANGELOG 的 Unreleased 段
 *
 * 流程:
 *   1. 前置检查: 干净工作区 / 在 main 分支 / 测试与 typecheck 通过
 *   2. 从 git log(conventional commits) 生成本版变更
 *   3. 更新 CHANGELOG.md(Unreleased 归档为新版本段) + 全部 package.json/app.json 版本递进
 *   4. commit "release: v<x.y.z>" + 打 tag + push(含 tag)
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { collectChanges, writeChangelog } from "./release-notes.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const changelogOnly = args.includes("--changelog-only");
const bump = args.find((a) => ["patch", "minor", "major"].includes(a));

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
const run = (cmd) => spawnSync("bash", ["-c", cmd], { cwd: ROOT, stdio: "inherit" });

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function bumpVersion(v, kind) {
  const [x, y, z] = v.split(".").map(Number);
  if (kind === "major") return `${x + 1}.0.0`;
  if (kind === "minor") return `${x}.${y + 1}.0`;
  return `${x}.${y}.${z + 1}`;
}

// ---- main ----
if (changelogOnly) {
  const groups = collectChanges(sh("git describe --tags --abbrev=0 2>/dev/null || echo ''"));
  console.log("Unreleased 段变更:");
  for (const [label, items] of groups) {
    console.log(`\n[${label}]`);
    for (const item of items) console.log(`  - ${item}`);
  }
  process.exit(0);
}

if (!bump) die("用法: node scripts/release.mjs patch|minor|major [--yes]");

// 1. 前置检查
const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "main" && branch !== "master") die(`必须在 main/master 分支, 当前 ${branch}`);
if (sh("git status --porcelain")) die("工作区不干净, 先提交所有变更");
console.log(`✓ 分支 ${branch}, 工作区干净`);

console.log("✓ 运行 typecheck + tests...");
if (run("pnpm typecheck && pnpm test").status !== 0) die("验证失败, 终止发布");

// 2. 版本递进 (调用统一版本脚本，确保 package.json、app.json 与 iOS Info.plist 完整一致)
const prevVersion = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).version;
const version = bumpVersion(prevVersion, bump);
const date = new Date().toISOString().slice(0, 10);
console.log(`✓ 版本 ${prevVersion} → ${version}`);

if (run(`node scripts/bump-version.mjs ${version}`).status !== 0) die("版本同步失败, 终止发布");

// 3. CHANGELOG
const groups = collectChanges(prevVersion ? `v${prevVersion}` : "");
writeChangelog(groups, version, date, prevVersion);
console.log("✓ CHANGELOG.md 已更新");

// 4. 预览 + commit + tag
console.log(`\n=== v${version} 变更摘要 ===`);
for (const [label, items] of groups) {
  console.log(`\n[${label}] (${items.length})`);
  for (const item of items.slice(0, 6)) console.log(`  - ${item}`);
  if (items.length > 6) console.log(`  ... 共 ${items.length} 条`);
}

if (!yes) {
  const r = spawnSync("bash", ["-c", 'read -p "确认发布 v' + version + '? [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]'], { stdio: "inherit" });
  if (r.status !== 0) die("已取消");
}

sh('git add -A && git commit -m "release: v' + version + '"');
sh("git tag v" + version);
console.log(`✓ 已 commit + tag v${version}`);
const push = run("git push origin HEAD && git push origin refs/tags/v" + version);
if (push.status !== 0) console.warn("! push 失败, 请手动 git push origin HEAD refs/tags/v" + version);
else console.log(`🎉 v${version} 发布完成`);

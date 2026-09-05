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
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const CHANGELOG = `${ROOT}CHANGELOG.md`;
const PKG_FILES = [
  "package.json",
  "apps/host/package.json",
  "apps/mobile/package.json",
  "packages/shared/package.json",
];
const APP_JSON = "apps/mobile/app.json";

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

/** 从 git log 生成一组 {type, items[]} */
function collectChanges(fromTag) {
  // tag 不存在(首次发版)时回退全量 HEAD
  const hasTag = fromTag
    ? spawnSync("git", ["rev-parse", "--verify", "--quiet", `${fromTag}^{commit}`], { cwd: ROOT }).status === 0
    : false;
  const range = hasTag ? `${fromTag}..HEAD` : "HEAD";
  const out = sh(`git log ${range} --pretty=format:%s`);
  const lines = out ? out.split("\n") : [];
  const groups = new Map(); // type -> items[]
  const skip = /^(release|chore\(deps\)|odyssey-|test\(notes\)|merge)/i;
  const typeLabel = {
    feat: "新增",
    fix: "修复",
    docs: "文档",
    perf: "性能",
    refactor: "重构",
    style: "样式",
    test: "测试",
  };
  for (const line of lines) {
    const m = line.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)/);
    if (!m || skip.test(line)) continue;
    const type = m[1].toLowerCase();
    const label = typeLabel[type] ?? "其他";
    if (!groups.has(label)) groups.set(label, []);
    const item = m[2].replace(/\s*\(#[0-9a-f]+\)\s*$/, "").trim();
    groups.get(label).push(item);
  }
  return groups;
}

/** 把 groups 写进 CHANGELOG 的指定版本段(替换 Unreleased 或插入顶部) */
function writeChangelog(groups, version, date, prevVersion) {
  let md = readFileSync(CHANGELOG, "utf8");
  let section = `## [${version}] — ${date}\n`;
  if (groups.size === 0) section += "\n- 维护性发布\n";
  for (const [label, items] of groups) {
    section += `\n### ${label}\n\n`;
    for (const item of items) section += `- ${item}\n`;
  }
  // dedupe(同摘要多次 fix-rebase 会出现重复行)
  if (md.includes("## Unreleased")) {
    md = md.replace(/## Unreleased[\s\S]*?(?=\n## )/, "");
  }
  const header = md.slice(0, md.indexOf("## ["));
  const rest = md.slice(md.indexOf("## ["));
  md = header + section + "\n" + rest;
  md = md.replace(
    /\[unreleased\]:\s*\S*/,
    `[unreleased]: https://github.com/isulewli/pi-maestro-app-party/compare/v${version}...HEAD`,
  );
  md = md.replace(
    new RegExp(`\\[${prevVersion}\\]:\\s*\\S*`),
    `[${version}]: https://github.com/isulewli/pi-maestro-app-party/compare/v${prevVersion}...v${version}\n[${version}]: https://github.com/isulewli/pi-maestro-app-party/releases/tag/v${version}`,
  );
  writeFileSync(CHANGELOG, md);
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

// 2. 版本递进
const prevVersion = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).version;
const version = bumpVersion(prevVersion, bump);
const date = new Date().toISOString().slice(0, 10);
console.log(`✓ 版本 ${prevVersion} → ${version}`);

for (const f of PKG_FILES) {
  const p = `${ROOT}${f}`;
  const d = JSON.parse(readFileSync(p, "utf8"));
  d.version = version;
  writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
}
const appJson = `${ROOT}${APP_JSON}`;
const appRaw = readFileSync(appJson, "utf8");
writeFileSync(appJson, appRaw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));

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
const push = run("git push origin HEAD --follow-tags");
if (push.status !== 0) console.warn("! push 失败, 请手动 git push origin HEAD --follow-tags");
else console.log(`🎉 v${version} 发布完成`);

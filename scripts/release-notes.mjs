#!/usr/bin/env node
/**
 * Shared release notes and changelog helpers.
 *
 * CLI:
 *   node scripts/release-notes.mjs <version>
 *   node scripts/release-notes.mjs <version> --update --from <previous-version>
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CHANGELOG = resolve(ROOT, "CHANGELOG.md");

const TYPE_LABEL = {
  feat: "新增",
  fix: "修复",
  docs: "文档",
  perf: "性能",
  refactor: "重构",
  style: "样式",
  test: "测试",
};
const SKIP_COMMIT = /^(release|chore\(deps\)|odyssey-|test\(notes\)|merge)/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sh(command) {
  return execSync(command, { cwd: ROOT, encoding: "utf8" }).trim();
}

function hasGitRef(ref) {
  return Boolean(ref) && spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: ROOT },
  ).status === 0;
}

/** 从 Conventional Commits 生成一组 {type, items[]}。 */
export function collectChanges(fromTag) {
  const range = hasGitRef(fromTag) ? `${fromTag}..HEAD` : "HEAD";
  const output = sh(`git log ${range} --pretty=format:%s`);
  const groups = new Map();
  for (const line of output ? output.split("\n") : []) {
    const match = line.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)/);
    if (!match || SKIP_COMMIT.test(line)) continue;
    const label = TYPE_LABEL[match[1].toLowerCase()] ?? "其他";
    if (!groups.has(label)) groups.set(label, []);
    const item = match[2].replace(/\s*\(#[0-9a-f]+\)\s*$/, "").trim();
    groups.get(label).push(item);
  }
  return groups;
}

/** 把 groups 写入 CHANGELOG 的指定版本段。 */
export function writeChangelog(groups, version, date, prevVersion) {
  let markdown = readFileSync(CHANGELOG, "utf8");
  let section = `## [${version}] — ${date}\n`;
  if (groups.size === 0) section += "\n- 维护性发布\n";
  for (const [label, items] of groups) {
    section += `\n### ${label}\n\n`;
    for (const item of items) section += `- ${item}\n`;
  }

  if (markdown.includes("## Unreleased")) {
    markdown = markdown.replace(/## Unreleased[\s\S]*?(?=\n## )/, "");
  }
  const firstVersion = markdown.indexOf("## [");
  if (firstVersion === -1) throw new Error("CHANGELOG.md 缺少版本段");
  markdown = `${markdown.slice(0, firstVersion)}${section}\n${markdown.slice(firstVersion)}`;
  markdown = markdown.replace(
    /\[unreleased\]:\s*\S*/,
    `[unreleased]: https://github.com/isulewli/pi-maestro-app-party/compare/v${version}...HEAD`,
  );
  if (prevVersion) {
    markdown = markdown.replace(
      new RegExp(`\\[${escapeRegex(prevVersion)}\\]:\\s*\\S*`),
      `[${version}]: https://github.com/isulewli/pi-maestro-app-party/compare/v${prevVersion}...v${version}\n[${version}]: https://github.com/isulewli/pi-maestro-app-party/releases/tag/v${version}`,
    );
  }
  writeFileSync(CHANGELOG, markdown, "utf8");
}

function sectionForVersion(version, markdown = readFileSync(CHANGELOG, "utf8")) {
  if (!VERSION_RE.test(version)) throw new Error(`非法版本号: ${version}`);
  const heading = new RegExp(`^## \\[${escapeRegex(version)}\\].*$`, "m");
  const match = heading.exec(markdown);
  if (!match) throw new Error(`CHANGELOG.md 缺少 v${version} 的版本段`);
  const nextHeading = markdown.indexOf("\n## ", match.index + match[0].length);
  return markdown.slice(match.index, nextHeading === -1 ? markdown.length : nextHeading).trim();
}

const INSTALL_NOTES = `## 安装

- **Android**：下载 .apk 直接安装（已用 release key 签名）
- **iOS**：下载 unsigned .ipa，用 [Sideloadly](https://sideloadly.io)/AltStore + 自己的 Apple ID 重签后安装
- **PC Host**：\`npm install -g pi-maestro-mobile@VERSION\`，或 \`pi install npm:pi-maestro-mobile\`

完整部署文档见仓库 [docs/deploy.md](https://github.com/netcookies/pi-maestro-app-party/blob/main/docs/deploy.md)`;

/** 生成 GitHub Release 正文，始终包含指定版本的 changelog。 */
export function buildReleaseNotes(version) {
  const changelog = sectionForVersion(version);
  return `${changelog}\n\n${INSTALL_NOTES.replaceAll("VERSION", version)}`;
}

/** 本地备用发布在版本段不存在时补齐 CHANGELOG。 */
export function ensureChangelog(version, previousVersion) {
  try {
    sectionForVersion(version);
    return;
  } catch (error) {
    if (!previousVersion || !VERSION_RE.test(previousVersion)) throw error;
    writeChangelog(
      collectChanges(`v${previousVersion}`),
      version,
      new Date().toISOString().slice(0, 10),
      previousVersion,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const version = args.find((arg) => VERSION_RE.test(arg));
  if (!version) {
    console.error("用法: node scripts/release-notes.mjs <version> [--update --from <previous-version>]");
    process.exit(1);
  }
  try {
    if (args.includes("--update")) {
      const fromIndex = args.indexOf("--from");
      const previousVersion = fromIndex >= 0 ? args[fromIndex + 1] : "";
      ensureChangelog(version, previousVersion);
    }
    process.stdout.write(`${buildReleaseNotes(version)}\n`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

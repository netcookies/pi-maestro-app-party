#!/usr/bin/env node
/**
 * 跨平台版本同步统一脚本 (Local & CI 共用)
 *
 * 用法:
 *   node scripts/bump-version.mjs patch|minor|major
 *   node scripts/bump-version.mjs 0.3.1
 *   node scripts/bump-version.mjs 0.3.1 --build-number 17
 *
 * 作用对象:
 *   1. package.json (root)
 *   2. apps/host/package.json
 *   3. apps/mobile/package.json
 *   4. packages/shared/package.json
 *   5. apps/mobile/app.json (version, ios.buildNumber, android.versionCode)
 *   6. apps/mobile/ios/MaestroMobile/Info.plist (CFBundleShortVersionString, CFBundleVersion)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PKG_FILES = [
  "package.json",
  "apps/host/package.json",
  "apps/mobile/package.json",
  "packages/shared/package.json",
];
const APP_JSON_PATH = resolve(ROOT, "apps/mobile/app.json");
const INFO_PLIST_PATH = resolve(ROOT, "apps/mobile/ios/MaestroMobile/Info.plist");

const args = process.argv.slice(2);
const target = args[0];

if (!target) {
  console.error("用法: node scripts/bump-version.mjs <patch|minor|major|x.y.z> [--build-number <num>]");
  process.exit(1);
}

function parseSemver(v) {
  const parts = v.split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`非法版本号: ${v}`);
  }
  return parts;
}

function bumpSemver(current, kind) {
  const [x, y, z] = parseSemver(current);
  if (kind === "major") return `${x + 1}.0.0`;
  if (kind === "minor") return `${x}.${y + 1}.0`;
  if (kind === "patch") return `${x}.${y}.${z + 1}`;
  return kind; // 直接传入的具体版本号
}

// 1. 读取当前根目录版本
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const currentVersion = rootPkg.version;
const newVersion = ["major", "minor", "patch"].includes(target)
  ? bumpSemver(currentVersion, target)
  : target;

parseSemver(newVersion); // 验证格式

// 2. 计算或获取 Build Number
let explicitBuildNumber = null;
const bnIdx = args.indexOf("--build-number");
if (bnIdx !== -1 && args[bnIdx + 1]) {
  explicitBuildNumber = parseInt(args[bnIdx + 1], 10);
}

// 读取当前 buildNumber
let currentBuildNumber = 1;
try {
  const appJson = JSON.parse(readFileSync(APP_JSON_PATH, "utf8"));
  if (appJson.expo?.ios?.buildNumber) {
    currentBuildNumber = parseInt(appJson.expo.ios.buildNumber, 10) || 1;
  }
} catch {}

const newBuildNumber = explicitBuildNumber ?? (currentBuildNumber + 1);

console.log(`[bump-version] 版本更新: ${currentVersion} -> ${newVersion} (Build: ${newBuildNumber})`);

// 3. 更新所有 package.json
for (const rel of PKG_FILES) {
  const p = resolve(ROOT, rel);
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  pkg.version = newVersion;
  writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`  ✓ 更新 ${rel}`);
}

// 4. 更新 apps/mobile/app.json
if (readFileSync(APP_JSON_PATH, "utf8")) {
  const appJson = JSON.parse(readFileSync(APP_JSON_PATH, "utf8"));
  if (!appJson.expo) appJson.expo = {};
  appJson.expo.version = newVersion;
  if (!appJson.expo.ios) appJson.expo.ios = {};
  appJson.expo.ios.buildNumber = String(newBuildNumber);
  if (!appJson.expo.android) appJson.expo.android = {};
  appJson.expo.android.versionCode = newBuildNumber;
  writeFileSync(APP_JSON_PATH, JSON.stringify(appJson, null, 2) + "\n", "utf8");
  console.log(`  ✓ 更新 apps/mobile/app.json`);
}

// 5. 更新 apps/mobile/ios/MaestroMobile/Info.plist
try {
  let plist = readFileSync(INFO_PLIST_PATH, "utf8");
  plist = plist.replace(
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${newVersion}$2`
  );
  plist = plist.replace(
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${newBuildNumber}$2`
  );
  writeFileSync(INFO_PLIST_PATH, plist, "utf8");
  console.log(`  ✓ 更新 apps/mobile/ios/MaestroMobile/Info.plist`);
} catch (err) {
  console.warn(`  ! 更新 Info.plist 警告: ${err.message}`);
}

console.log(`[bump-version] 全部版本字段同步完毕: v${newVersion} (${newBuildNumber})`);

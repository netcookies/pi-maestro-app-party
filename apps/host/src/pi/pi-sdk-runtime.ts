import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SessionCatalog } from "../types.js";

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/** Host 用到的 Pi SDK 运行时子集：只做只读会话枚举 */
type PiSdkRuntime = Pick<typeof import("@earendil-works/pi-coding-agent"), "SessionManager">;

/** 条件导出目标：字符串即目标，条件对象取 import → default（原生 ESM 优先） */
function pickTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  return pickTarget(conditions.import) ?? pickTarget(conditions.default);
}

/**
 * 从包目录解析 ESM 入口文件。
 * Pi 的 `exports["."]` 只有 import/types 条件，`require.resolve` 会直接报
 * "No exports main defined"，因此必须读 manifest 自行解析。
 */
async function entryFromPackageDir(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      main?: unknown;
      exports?: unknown;
    };
    const rootExport = typeof manifest.exports === "object" && manifest.exports !== null
      ? (manifest.exports as Record<string, unknown>)["."]
      : manifest.exports; // exports 写成字符串时本身就是 "." 的目标
    const target = pickTarget(rootExport) ?? pickTarget(manifest.main);
    if (!target) return undefined;
    const entry = resolve(packageDir, target);
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function importPackageDir(packageDir: string): Promise<PiSdkRuntime | undefined> {
  const entry = await entryFromPackageDir(packageDir);
  if (!entry) return undefined;
  try {
    return (await import(pathToFileURL(entry).href)) as PiSdkRuntime;
  } catch {
    return undefined;
  }
}

/**
 * PATH / NODE_PATH 推导出的全局 node_modules 候选。
 * npm 全局布局差异大：homebrew/nvm 是 `<prefix>/bin` → `<prefix>/lib/node_modules`，
 * Windows 是 `%APPDATA%\npm` → 其下直接是包目录。用两侧推导代替写死平台前缀。
 */
function globalNodeModulesRoots(): string[] {
  const roots = new Set<string>();
  const add = (dir: string): void => {
    if (dir.length > 0 && existsSync(dir)) roots.add(dir);
  };
  for (const dir of (process.env.NODE_PATH ?? "").split(delimiter)) add(dir);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    add(join(dir, "node_modules"));
    add(join(dir, "..", "lib", "node_modules"));
  }
  return [...roots];
}

/**
 * 解析 Pi SDK 运行时。
 *
 * Host 是被 extension 拉起的独立 Node 进程，不经过 Pi 扩展加载器，拿不到加载器给扩展注入的
 * host-provided peer 映射，所以按顺序回退：
 *  1. `PI_PACKAGE_DIR`（Pi 官方约定，`getPackageDir()` 读同一个变量）：extension 启动子进程时
 *     注入宿主自身包目录，复用宿主正在运行的那一份 runtime，不额外安装副本；
 *  2. 常规 Node 解析：workspace 开发，或 npm 本地/全局安装（peer dependency 随包安装）;
 *  3. 全局 node_modules：Pi 装在全局、Host 独立安装（本机 ~/.pi/agent/npm）的形态。
 */
export async function loadPiSdk(): Promise<PiSdkRuntime> {
  const injected = process.env.PI_PACKAGE_DIR?.trim();
  if (injected) {
    const fromHost = await importPackageDir(injected);
    if (fromHost) return fromHost;
  }
  try {
    return (await import("@earendil-works/pi-coding-agent")) as PiSdkRuntime;
  } catch {
    // 常规解析不可用 → 继续尝试全局安装前缀
  }
  for (const root of globalNodeModulesRoots()) {
    const fromGlobal = await importPackageDir(join(root, PI_SDK_PACKAGE));
    if (fromGlobal) return fromGlobal;
  }
  throw new Error(
    `无法加载 Pi runtime ${PI_SDK_PACKAGE}（PI_PACKAGE_DIR=${injected ?? "未设置"}）。`
    + "请在 Pi 宿主内用 /maestro-mobile start 启动（扩展会注入宿主 runtime 目录），"
    + `或把 PI_PACKAGE_DIR 指向 Pi 包目录，或安装 ${PI_SDK_PACKAGE}。`,
  );
}

/**
 * 只读持久化会话目录。
 *
 * Host 不再通过 Pi SDK 创建或附着 AgentSession；这里仅复用 SDK 的
 * SessionManager.list() 枚举已有 JSONL 索引，实际内容由 SessionQueryService 读取。
 * SDK 在首次列举时按需解析：解析失败只让会话接口显式报错，不再让整个 Host 进程起不来。
 */
export class PiSessionCatalog implements SessionCatalog {
  constructor(private readonly projectRoot = process.cwd()) {}

  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    const { SessionManager } = await loadPiSdk();
    return SessionManager.list(cwd ?? this.projectRoot);
  }
}

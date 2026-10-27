import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DesktopPluginTarget, HerdrRuntime } from "@maestro-mobile/shared";

export interface HerdrLaunchedSpaceRecord {
  paneId: string;
  workspaceId?: string;
  target: DesktopPluginTarget;
  label?: string;
  cwd: string;
  runtime?: HerdrRuntime;
  launchedAt: string;
}

export interface HerdrLaunchStoreData {
  schemaVersion: 1;
  favorites: string[];
  settings: { runtime: HerdrRuntime; resumeHistory: boolean; autoCleanupSpace: boolean };
  launchedSpaces: HerdrLaunchedSpaceRecord[];
}

export class HerdrLaunchStoreError extends Error {
  constructor(message = "herdr launch configuration is invalid or unavailable") {
    super(message);
    this.name = "HerdrLaunchStoreError";
  }
}

const SCHEMA_VERSION = 1 as const;
const RUNTIMES: readonly HerdrRuntime[] = ["auto", "pi", "pi-bolt"];

export function defaultHerdrLaunchData(): HerdrLaunchStoreData {
  return {
    schemaVersion: SCHEMA_VERSION,
    favorites: [],
    settings: { runtime: "auto", resumeHistory: true, autoCleanupSpace: true },
    launchedSpaces: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAbsolutePathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry) && entry.startsWith("/"));
}

function isLaunchedSpace(value: unknown): value is HerdrLaunchedSpaceRecord {
  if (!isRecord(value)) return false;
  const target = value.target;
  return isString(value.paneId)
    && isString(value.cwd) && value.cwd.startsWith("/")
    && isString(value.launchedAt)
    && isRecord(target)
    && isString(target.sessionId) && isString(target.endpointId)
    && isString(target.normalizedCwd) && isString(target.processGeneration)
    && (value.workspaceId === undefined || isString(value.workspaceId))
    && (value.runtime === undefined || RUNTIMES.includes(value.runtime as HerdrRuntime))
    && (value.label === undefined || typeof value.label === "string");
}

function validate(data: HerdrLaunchStoreData): HerdrLaunchStoreData {
  if (data.schemaVersion !== SCHEMA_VERSION) throw new HerdrLaunchStoreError();
  if (!isAbsolutePathArray(data.favorites)) throw new HerdrLaunchStoreError();
  if (!Array.isArray(data.launchedSpaces) || !data.launchedSpaces.every(isLaunchedSpace)) throw new HerdrLaunchStoreError();
  const settings = data.settings;
  if (!isRecord(settings) || !RUNTIMES.includes(settings.runtime as HerdrRuntime)
    || typeof settings.resumeHistory !== "boolean" || typeof settings.autoCleanupSpace !== "boolean") {
    throw new HerdrLaunchStoreError();
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    favorites: [...data.favorites],
    settings: { ...settings } as HerdrLaunchStoreData["settings"],
    launchedSpaces: data.launchedSpaces.map((entry) => ({ ...entry })),
  };
}

function parse(raw: string): HerdrLaunchStoreData {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new HerdrLaunchStoreError();
    return validate({ ...defaultHerdrLaunchData(), ...value } as HerdrLaunchStoreData);
  } catch (error) {
    if (error instanceof HerdrLaunchStoreError) throw error;
    throw new HerdrLaunchStoreError();
  }
}

export function herdrLaunchStorePath(): string {
  if (process.env.VITEST) return join(tmpdir(), `maestro-herdr-test-${process.pid}-${randomUUID()}.json`);
  return join(homedir(), ".pi", "maestro-mobile-herdr.json");
}

/** 每次操作直接读盘 + 原子写回；不做内存缓存，避免 Plugin/Host 交叉写丢更新。 */
export class HerdrLaunchStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string = herdrLaunchStorePath()) {}

  async read(): Promise<HerdrLaunchStoreData> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultHerdrLaunchData();
      throw new HerdrLaunchStoreError();
    }
    return parse(raw);
  }

  private async writeAtomic(data: HerdrLaunchStoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  /** 串行化本进程内的读-改-写；损坏文件按默认值重建后继续本次修改。 */
  private mutate(mutator: (data: HerdrLaunchStoreData) => Promise<HerdrLaunchStoreData> | HerdrLaunchStoreData): Promise<HerdrLaunchStoreData> {
    const run = this.mutationQueue.then(async () => {
      let data: HerdrLaunchStoreData;
      try {
        data = await this.read();
      } catch {
        data = defaultHerdrLaunchData();
      }
      const next = validate(await mutator(data));
      await this.writeAtomic(next);
      return next;
    });
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  async updateSettings(patch: { runtime?: HerdrRuntime; resumeHistory?: boolean; autoCleanupSpace?: boolean }): Promise<HerdrLaunchStoreData["settings"]> {
    return this.mutate(async (data) => ({ ...data, settings: { ...data.settings, ...patch } }))
      .then((data) => data.settings);
  }

  async addFavorite(path: string): Promise<string[]> {
    return this.mutate(async (data) => {
      if (!data.favorites.includes(path)) data = { ...data, favorites: [...data.favorites, path] };
      return data;
    }).then((data) => data.favorites);
  }

  async removeFavorite(path: string): Promise<string[]> {
    return this.mutate(async (data) => ({ ...data, favorites: data.favorites.filter((entry) => entry !== path) }))
      .then((data) => data.favorites);
  }

  /** 整表替换：表达排序与批量整理（协议层已校验唯一性与长度） */
  async replaceFavorites(paths: string[]): Promise<string[]> {
    return this.mutate(async (data) => ({ ...data, favorites: [...paths] }))
      .then((data) => data.favorites);
  }

  async recordLaunch(entry: HerdrLaunchedSpaceRecord): Promise<void> {
    await this.mutate(async (data) => ({ ...data, launchedSpaces: [...data.launchedSpaces, { ...entry }] }));
  }

  async removeLaunch(paneId: string): Promise<void> {
    await this.mutate(async (data) => ({ ...data, launchedSpaces: data.launchedSpaces.filter((entry) => entry.paneId !== paneId) }));
  }

  async listLaunches(): Promise<HerdrLaunchedSpaceRecord[]> {
    return (await this.read()).launchedSpaces;
  }
}

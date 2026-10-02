import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  ExecutionProjection,
  HostSessionList,
  MaestroState,
  MonitorState,
  SessionTargetIdentity,
  SessionUsageSummary,
} from "@maestro-mobile/shared";

export const MOBILE_STARTUP_CACHE_KEY = "maestro-mobile.startup-snapshot";
export const MOBILE_STARTUP_CACHE_SCHEMA_VERSION = 1;
export const SESSION_SNAPSHOT_TTL_MS = 60_000;
export const MONITOR_SNAPSHOT_TTL_MS = 30_000;

export interface StartupCacheIdentity {
  hostUrl: string;
  tokenFingerprint: string;
}

export interface StartupSnapshot {
  schemaVersion: number;
  identity: StartupCacheIdentity;
  savedAt: number;
  sessions?: HostSessionList;
  maestro?: MaestroState | null;
  monitor?: MonitorState;
  executionProjections?: ExecutionProjection[];
  usage?: { target: SessionTargetIdentity; value: SessionUsageSummary }[];
}

export interface LoadedStartupSnapshot extends StartupSnapshot {
  stale: boolean;
}

export interface SnapshotStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const defaultStorage: SnapshotStorage = AsyncStorage;

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function startupCacheIdentity(hostUrl: string, token?: string): StartupCacheIdentity {
  return { hostUrl: hostUrl.trim().replace(/\/$/, ""), tokenFingerprint: fingerprint(token ?? "") };
}

function isIdentity(value: unknown): value is StartupCacheIdentity {
  return Boolean(value && typeof value === "object"
    && typeof (value as StartupCacheIdentity).hostUrl === "string"
    && typeof (value as StartupCacheIdentity).tokenFingerprint === "string");
}

function isSnapshot(value: unknown): value is StartupSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<StartupSnapshot>;
  return snapshot.schemaVersion === MOBILE_STARTUP_CACHE_SCHEMA_VERSION
    && isIdentity(snapshot.identity)
    && typeof snapshot.savedAt === "number"
    && Number.isFinite(snapshot.savedAt)
    && (snapshot.sessions === undefined || (typeof snapshot.sessions === "object" && Array.isArray(snapshot.sessions.sessions)))
    && (snapshot.executionProjections === undefined || Array.isArray(snapshot.executionProjections))
    && (snapshot.usage === undefined || Array.isArray(snapshot.usage));
}

export function readStartupSnapshot(raw: string | null, identity: StartupCacheIdentity, now = Date.now()): LoadedStartupSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSnapshot(parsed)) return null;
    if (parsed.identity.hostUrl !== identity.hostUrl || parsed.identity.tokenFingerprint !== identity.tokenFingerprint) return null;
    const sessionStale = parsed.sessions !== undefined && now - parsed.savedAt > SESSION_SNAPSHOT_TTL_MS;
    const monitorStale = parsed.monitor !== undefined && now - parsed.savedAt > MONITOR_SNAPSHOT_TTL_MS;
    return { ...parsed, stale: sessionStale || monitorStale };
  } catch {
    return null;
  }
}

export async function loadStartupSnapshot(identity: StartupCacheIdentity, storage: SnapshotStorage = defaultStorage, now = Date.now()): Promise<LoadedStartupSnapshot | null> {
  try {
    return readStartupSnapshot(await storage.getItem(MOBILE_STARTUP_CACHE_KEY), identity, now);
  } catch {
    return null;
  }
}

export async function saveStartupSnapshot(snapshot: StartupSnapshot, storage: SnapshotStorage = defaultStorage): Promise<void> {
  if (snapshot.schemaVersion !== MOBILE_STARTUP_CACHE_SCHEMA_VERSION) return;
  try {
    await storage.setItem(MOBILE_STARTUP_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // 本地缓存失败不应影响网络数据或导航。
  }
}

export async function updateStartupSnapshot(
  identity: StartupCacheIdentity,
  patch: Omit<Partial<StartupSnapshot>, "schemaVersion" | "identity" | "savedAt">,
  storage: SnapshotStorage = defaultStorage,
  now = Date.now(),
): Promise<void> {
  const current = await loadStartupSnapshot(identity, storage, now);
  await saveStartupSnapshot({
    schemaVersion: MOBILE_STARTUP_CACHE_SCHEMA_VERSION,
    identity,
    savedAt: now,
    ...(current ?? {}),
    ...patch,
  }, storage);
}

export function usageEntriesForSnapshot(usage: Map<string, SessionUsageSummary>, targets: Map<string, SessionTargetIdentity>) {
  return [...usage.entries()].flatMap(([key, value]) => {
    const target = targets.get(key);
    return target ? [{ target, value }] : [];
  });
}

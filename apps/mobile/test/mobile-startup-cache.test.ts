import { describe, expect, it } from "vitest";
import {
  MOBILE_STARTUP_CACHE_SCHEMA_VERSION,
  MONITOR_SNAPSHOT_TTL_MS,
  SESSION_SNAPSHOT_TTL_MS,
  loadStartupSnapshot,
  readStartupSnapshot,
  saveStartupSnapshot,
  startupCacheIdentity,
  type SnapshotStorage,
  type StartupSnapshot,
} from "../src/mobile-startup-cache.js";

function storage(initial?: string): SnapshotStorage {
  let value = initial ?? null;
  return {
    getItem: async () => value,
    setItem: async (_key, next) => { value = next; },
  };
}

const identity = startupCacheIdentity("ws://host:123/", "secret");
const snapshot: StartupSnapshot = {
  schemaVersion: MOBILE_STARTUP_CACHE_SCHEMA_VERSION,
  identity,
  savedAt: 1_000,
  sessions: { observedAt: new Date(1_000).toISOString(), sessions: [] },
};

describe("mobile startup cache", () => {
  it("isolates snapshots by normalized host and token fingerprint", async () => {
    const store = storage();
    await saveStartupSnapshot(snapshot, store);
    expect(await loadStartupSnapshot(startupCacheIdentity("ws://host:123/", "secret"), store, 1_001)).not.toBeNull();
    expect(await loadStartupSnapshot(startupCacheIdentity("ws://host:123/", "other"), store, 1_001)).toBeNull();
    expect(await loadStartupSnapshot(startupCacheIdentity("ws://other:123", "secret"), store, 1_001)).toBeNull();
  });

  it("rejects malformed, wrong-version, and invalid JSON payloads", () => {
    expect(readStartupSnapshot("not-json", identity, 1_001)).toBeNull();
    expect(readStartupSnapshot(JSON.stringify({ ...snapshot, schemaVersion: 99 }), identity, 1_001)).toBeNull();
    expect(readStartupSnapshot(JSON.stringify({ ...snapshot, sessions: { sessions: "bad" } }), identity, 1_001)).toBeNull();
  });

  it("marks a snapshot stale using bounded session and monitor TTLs", () => {
    const sessionStale = readStartupSnapshot(JSON.stringify(snapshot), identity, snapshot.savedAt + SESSION_SNAPSHOT_TTL_MS + 1);
    expect(sessionStale?.stale).toBe(true);
    const fresh = readStartupSnapshot(JSON.stringify(snapshot), identity, snapshot.savedAt + Math.min(SESSION_SNAPSHOT_TTL_MS, MONITOR_SNAPSHOT_TTL_MS) - 1);
    expect(fresh?.stale).toBe(false);
  });

  it("round-trips through the storage adapter without leaking the token", async () => {
    const store = storage();
    await saveStartupSnapshot(snapshot, store);
    const loaded = await loadStartupSnapshot(identity, store, 1_001);
    expect(loaded?.identity).toEqual(identity);
    expect(JSON.stringify(loaded)).not.toContain("secret");
  });
});

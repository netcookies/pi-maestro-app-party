import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { HostSessionListService } from "../src/server/helpers.js";

const roots: string[] = [];

function record(
  id: string,
  modified: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    cwd: "/work/default",
    path: `/sessions/${id}.txt`,
    firstMessage: `Title ${id}`,
    messageCount: 1,
    modified,
    ...overrides,
  };
}

async function service(): Promise<{ instance: HostSessionListService; indexPath: string }> {
  const root = join(tmpdir(), `maestro-session-list-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  const indexPath = join(root, "index.json");
  return { instance: new HostSessionListService({ indexPath, staleAfterMs: 60_000 }), indexPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HostSessionListService", () => {
  it("uses a stable updatedAt + id cursor when newer sessions are inserted", async () => {
    const first = await service();
    const initial = [
      record("a", "2026-01-02T00:00:00.000Z"),
      record("b", "2026-01-02T00:00:00.000Z"),
      record("old", "2026-01-01T00:00:00.000Z"),
    ];
    const page1 = await first.instance.list(async () => initial, { limit: 2 });
    expect(page1.sessions.map((item) => item.id)).toEqual(["b", "a"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(3);

    const second = await service();
    const withInsertion = [record("new", "2026-01-03T00:00:00.000Z"), ...initial];
    const page2 = await second.instance.list(async () => withInsertion, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.sessions.map((item) => item.id)).toEqual(["old"]);
    expect(page2.hasMore).toBe(false);
  });

  it("searches title, id, cwd, model, and name across the full index before paging", async () => {
    const { instance } = await service();
    const records = [
      record("id-needle", "2026-01-05T00:00:00.000Z"),
      record("title", "2026-01-04T00:00:00.000Z", { firstMessage: "Needle title" }),
      record("cwd", "2026-01-03T00:00:00.000Z", { cwd: "/work/Needle" }),
      record("model", "2026-01-02T00:00:00.000Z", { model: "provider/needle-model" }),
      record("name", "2026-01-01T00:00:00.000Z", { name: "Needle name" }),
      record("miss", "2025-01-01T00:00:00.000Z"),
    ];
    const result = await instance.list(async () => records, { query: "NEEDLE", limit: 10 });
    expect(result.sessions.map((item) => item.id)).toEqual(["id-needle", "title", "cwd", "model", "name"]);
    expect(result.total).toBe(5);
  });

  it("returns the union of requested ids and the latest session for each cwd", async () => {
    const { instance } = await service();
    const records = [
      record("other", "2026-01-05T00:00:00.000Z", { cwd: "/work/other" }),
      record("latest-a", "2026-01-04T00:00:00.000Z", { cwd: "/work/a" }),
      record("by-id", "2026-01-03T00:00:00.000Z", { cwd: "/work/b" }),
      record("older-a", "2026-01-02T00:00:00.000Z", { cwd: "/work/a" }),
    ];
    const result = await instance.list(async () => records, {
      sessionIds: ["by-id", "latest-a"],
      latestForCwds: ["/work/a"],
    });
    expect(result.sessions.map((item) => item.id)).toEqual(["latest-a", "by-id"]);
    expect(result.targeted).toBe(true);
    expect(result).not.toHaveProperty("total");
  });

  it("bounds targeted filters and rejects mixing them with pagination", async () => {
    const { instance } = await service();
    const load = async () => [];
    await expect(instance.list(load, { sessionIds: Array.from({ length: 101 }, (_, i) => `s-${i}`) })).rejects.toThrow("at most 100");
    await expect(instance.list(load, { latestForCwds: [""] })).rejects.toThrow("non-empty strings");
    await expect(instance.list(load, { sessionIds: ["s"], limit: 10 })).rejects.toThrow("cannot be combined");
  });

  it("keeps legacy no-limit requests full and does not scan again for later pages", async () => {
    const { instance } = await service();
    let loads = 0;
    const load = async () => {
      loads++;
      return [
        record("three", "2026-01-03T00:00:00.000Z"),
        record("two", "2026-01-02T00:00:00.000Z"),
        record("one", "2026-01-01T00:00:00.000Z"),
      ];
    };
    const legacy = await instance.list(load);
    expect(legacy.sessions).toHaveLength(3);
    expect(legacy).not.toHaveProperty("total");
    expect(legacy).not.toHaveProperty("hasMore");

    const page1 = await instance.list(load, { limit: 1 });
    await instance.list(load, { limit: 1, cursor: page1.nextCursor });
    expect(loads).toBe(1);
  });

  it("validates page boundaries and cursor shape", async () => {
    const { instance } = await service();
    const load = async () => [];
    await expect(instance.list(load, { limit: 0 })).rejects.toThrow("between 1 and 100");
    await expect(instance.list(load, { limit: 101 })).rejects.toThrow("between 1 and 100");
    await expect(instance.list(load, { cursor: "abc" })).rejects.toThrow("cursor requires limit");
    await expect(instance.list(load, { limit: 10, cursor: "abc" })).rejects.toThrow("invalid session cursor");
  });

  it("refreshes stale data in the background so external changes become visible", async () => {
    const root = join(tmpdir(), `maestro-session-list-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    let now = 1_000;
    const instance = new HostSessionListService({
      indexPath: join(root, "index.json"),
      staleAfterMs: 10,
      now: () => now,
    });
    await instance.list(async () => [record("old", "2026-01-01T00:00:00.000Z")], { limit: 10 });

    now += 20;
    const stale = await instance.list(async () => [record("new", "2026-01-02T00:00:00.000Z")], { limit: 10 });
    expect(stale.sessions.map((item) => item.id)).toEqual(["old"]);
    await expect.poll(async () => (await instance.list(async () => [], { limit: 10 })).sessions[0]?.id)
      .toBe("new");
  });

  it("reuses the persistent summary index on a later cold start", async () => {
    const first = await service();
    await first.instance.list(async () => [record("persisted", "2026-01-01T00:00:00.000Z")], { limit: 10 });

    let loads = 0;
    const restarted = new HostSessionListService({ indexPath: first.indexPath, staleAfterMs: 60_000 });
    const result = await restarted.list(async () => {
      loads++;
      return [];
    }, { limit: 10 });
    expect(result.sessions.map((item) => item.id)).toEqual(["persisted"]);
    expect(loads).toBe(0);
  });

  it("falls back to the loader for a corrupt index and persists summary-only data", async () => {
    const { instance, indexPath } = await service();
    await writeFile(indexPath, "{broken", "utf8");
    let loads = 0;
    const result = await instance.list(async () => {
      loads++;
      return [record("safe", "2026-01-01T00:00:00.000Z", { token: "must-not-persist" })];
    }, { limit: 10 });
    expect(result.sessions.map((item) => item.id)).toEqual(["safe"]);
    expect(loads).toBe(1);
    expect(await readFile(indexPath, "utf8")).not.toContain("must-not-persist");
  });
});

describe("session summary date normalization", () => {
  it("normalizes dates into Hermes-compatible ISO strings", async () => {
    const { instance } = await service();
    const result = await instance.list(async () => [
      record("date", "Thu Sep 03 2026 16:59:03 GMT+0800 (China Standard Time)"),
    ]);
    expect(result.sessions[0].updatedAt).toBe("2026-09-03T08:59:03.000Z");
  });
});

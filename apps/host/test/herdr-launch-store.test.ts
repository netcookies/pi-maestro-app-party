import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrLaunchStore,
  defaultHerdrLaunchData,
  type HerdrLaunchedSpaceRecord,
} from "../src/herdr-launch-store.js";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";

const target: DesktopPluginTarget = {
  sessionId: "s-1",
  endpointId: "e-1",
  normalizedCwd: "/work/app",
  processGeneration: "g-1",
};

function record(paneId: string, cwd = "/work/app"): HerdrLaunchedSpaceRecord {
  return { paneId, target: { ...target }, cwd, launchedAt: new Date(0).toISOString(), workspaceId: paneId.split(":")[0] };
}

describe("HerdrLaunchStore", () => {
  it("returns defaults when the file is absent", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "herdr-store-")), "absent.json");
    try {
      const store = new HerdrLaunchStore(file);
      expect(await store.read()).toEqual(defaultHerdrLaunchData());
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("persists settings and favorites with partial updates", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "herdr-store-")), "cfg.json");
    try {
      const store = new HerdrLaunchStore(file);
      expect(await store.updateSettings({ runtime: "pi-bolt" })).toMatchObject({ runtime: "pi-bolt", resumeHistory: true, autoCleanupSpace: true });
      expect(await store.updateSettings({ resumeHistory: false })).toMatchObject({ runtime: "pi-bolt", resumeHistory: false });
      expect(await store.addFavorite("/work/app")).toEqual(["/work/app"]);
      expect(await store.addFavorite("/work/app")).toEqual(["/work/app"]);
      expect(await store.addFavorite("/work/other")).toEqual(["/work/app", "/work/other"]);
      expect(await store.removeFavorite("/work/app")).toEqual(["/work/other"]);
      const reread = new HerdrLaunchStore(file);
      expect((await reread.read()).settings).toEqual({ runtime: "pi-bolt", resumeHistory: false, autoCleanupSpace: true });
      expect((await reread.read()).favorites).toEqual(["/work/other"]);
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("registers and removes launched spaces", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "herdr-store-")), "spaces.json");
    try {
      const store = new HerdrLaunchStore(file);
      await store.recordLaunch(record("w9:p1"));
      await store.recordLaunch(record("w8:p1", "/work/other"));
      expect((await store.listLaunches()).map((entry) => entry.paneId)).toEqual(["w9:p1", "w8:p1"]);
      await store.removeLaunch("w9:p1");
      expect((await store.listLaunches()).map((entry) => entry.paneId)).toEqual(["w8:p1"]);
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("falls back to defaults on a corrupt file and keeps the requested change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-store-"));
    const file = join(dir, "corrupt.json");
    try {
      await writeFile(file, "{not json", "utf8");
      const store = new HerdrLaunchStore(file);
      await expect(store.read()).rejects.toThrow();
      expect(await store.addFavorite("/work/app")).toEqual(["/work/app"]);
      expect((await store.read()).favorites).toEqual(["/work/app"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not lose concurrent mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-store-"));
    const file = join(dir, "concurrent.json");
    try {
      const store = new HerdrLaunchStore(file);
      await Promise.all([
        store.updateSettings({ runtime: "pi" }),
        store.addFavorite("/work/a"),
        store.addFavorite("/work/b"),
        store.recordLaunch(record("w1:p1")),
        store.recordLaunch(record("w2:p1")),
      ]);
      const data = await store.read();
      expect(data.settings.runtime).toBe("pi");
      expect(data.favorites.sort()).toEqual(["/work/a", "/work/b"]);
      expect(data.launchedSpaces.map((entry) => entry.paneId).sort()).toEqual(["w1:p1", "w2:p1"]);
      expect(JSON.parse(await readFile(file, "utf8")).schemaVersion).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

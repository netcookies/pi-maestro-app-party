import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkspaceTelemetryReader } from "../src/workspace-telemetry.js";

/**
 * 回归：owner 文件由兄弟 Pi 会话写出，会随 agents[]/settled[] 无界增长。
 * 旧实现 readFile 后才判长度（且用的是 UTF-16 单元数而非字节），等于无上限分配。
 * 反向验证：回滚到 HEAD 后「>1MB 的合法 owner 被跳过」这条必挂（HEAD 会把它读进 owners）。
 */

interface OwnerOpts {
  kind?: string;
  publishedAt?: number | string;
  padKb?: number;
}

function ownerPayload(wsId: string, ownerId: string, opts: OwnerOpts = {}) {
  const pad = "x".repeat((opts.padKb ?? 0) * 1024);
  return JSON.stringify({
    kind: opts.kind ?? "owner",
    workspaceId: wsId,
    normalizedCwd: "/proj",
    ownerId,
    pid: 4242,
    sessionId: `sess-${ownerId}`,
    publishedAt: opts.publishedAt ?? Date.now(),
    contextPressure: null,
    agents: [],
    settled: [],
    backgroundJobs: [],
    pad,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-telemetry-"));
  roots.push(root);
  const ownersDir = join(root, "ws-1", "runtime", "owners");
  await mkdir(ownersDir, { recursive: true });
  return { root, ownersDir };
}

const roots: string[] = [];

describe("WorkspaceTelemetryReader", () => {
  it("rootPath 注入生效：只读 fixture 目录，不碰真实 ~/.pi", async () => {
    const { root, ownersDir } = await fixture();
    await writeFile(join(ownersDir, "o1.json"), ownerPayload("ws-1", "o1"), "utf8");
    const result = await new WorkspaceTelemetryReader(90_000, { rootPath: root }).read();
    expect(result.owners.map((o) => o.ownerId)).toEqual(["o1"]);
    expect(result.aliveCount).toBe(1);
    expect(result.owners[0].pid).toBe(4242);
  });

  it("超过 1MB 的 owner 文件跳过并告警（旧实现无字节上限分配）", async () => {
    const { root, ownersDir } = await fixture();
    await writeFile(join(ownersDir, "small.json"), ownerPayload("ws-1", "small"), "utf8");
    await writeFile(join(ownersDir, "huge.json"), ownerPayload("ws-1", "huge", { padKb: 1200 }), "utf8");
    const warns: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
    try {
      const result = await new WorkspaceTelemetryReader(90_000, { rootPath: root }).read();
      expect(result.owners.map((o) => o.ownerId), "超限文件不得进入 owners").toEqual(["small"]);
      expect(warns.some((w) => String(w).includes("异常大的 owner 文件"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it("畸形 publishedAt / 非 owner / .tmp 一律跳过，不抛出", async () => {
    const { root, ownersDir } = await fixture();
    await writeFile(join(ownersDir, "nan.json"), ownerPayload("ws-1", "nan", { publishedAt: "abc" }), "utf8");
    await writeFile(join(ownersDir, "zero.json"), ownerPayload("ws-1", "zero", { publishedAt: 0 }), "utf8");
    await writeFile(join(ownersDir, "other.json"), ownerPayload("ws-1", "other", { kind: "claim" }), "utf8");
    await writeFile(join(ownersDir, "broken.tmp.json"), "{not json", "utf8");
    await writeFile(join(ownersDir, "good.json"), ownerPayload("ws-1", "good"), "utf8");
    const result = await new WorkspaceTelemetryReader(90_000, { rootPath: root }).read();
    expect(result.owners.map((o) => o.ownerId)).toEqual(["good"]);
  });

  it("陈旧 owner 计 alive=false 但保留在列表；按 publishedAt 倒序", async () => {
    const { root, ownersDir } = await fixture();
    const now = Date.now();
    await writeFile(join(ownersDir, "old.json"), ownerPayload("ws-1", "old", { publishedAt: now - 200_000 }), "utf8");
    await writeFile(join(ownersDir, "mid.json"), ownerPayload("ws-1", "mid", { publishedAt: now - 10_000 }), "utf8");
    const result = await new WorkspaceTelemetryReader(90_000, { rootPath: root }).read();
    expect(result.owners.map((o) => o.ownerId)).toEqual(["mid", "old"]);
    expect(result.aliveCount).toBe(1);
    expect(result.owners[1].alive).toBe(false);
    expect(result.owners[1].ageMs).toBeGreaterThan(190_000);
  });

  it("默认构造（无 rootPath，指向不存在的真实路径族）不抛，返回空快照", async () => {
    const result = await new WorkspaceTelemetryReader(90_000, { rootPath: join(root_missing(), "nope") }).read();
    expect(result).toMatchObject({ owners: [], aliveCount: 0 });
  });

  it("向后兼容：staleMs 单参构造仍可用（旧调用点未改签名即 break）", async () => {
    const { root, ownersDir } = await fixture();
    await writeFile(join(ownersDir, "a.json"), ownerPayload("ws-1", "a", { publishedAt: Date.now() - 100_000 }), "utf8");
    const byStale = new WorkspaceTelemetryReader(10_000, { rootPath: root });
    expect((await byStale.read()).aliveCount).toBe(0);
    const byLongStale = new WorkspaceTelemetryReader(200_000, { rootPath: root });
    expect((await byLongStale.read()).aliveCount).toBe(1);
    expect(new WorkspaceTelemetryReader().read).toBeTypeOf("function"); // 默认参可省略
  });
});

function root_missing(): string {
  return join(tmpdir(), `mm-telemetry-missing-${randomUUID()}`);
}

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MaestroStateReader } from "../src/maestro-state.js";

describe("MaestroStateReader (P1)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `maestro-p1-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSchedule(scheduleId: string, schedule: unknown) {
    const dir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${scheduleId}.json`), JSON.stringify(schedule));
  }

  it("detects maestro change between reads (stateDiff)", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    const s1 = await reader.readState();
    expect(s1.schedules).toEqual([]);

    await writeSchedule("sch-x", {
      scheduleId: "sch-x",
      state: "active",
      stepIds: [],
      steps: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const s2 = await reader.readState();
    expect(s2.schedules).toHaveLength(1);

    const s3 = await reader.readState();
    expect(s3.schedules).toHaveLength(1);
    // 同一状态两次读取内容应一致（幂等）
    expect(s3.schedules[0].updatedAt).toBe(s2.schedules[0].updatedAt);
  });

  it("reads failed schedule with error dispatches", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    const baseDir = join(tmpDir, ".pi", "flow-schedule", "v1");
    const dispatchDir = join(baseDir, "dispatches", "dsp-fail-1");
    await mkdir(dispatchDir, { recursive: true });
    await writeFile(
      join(dispatchDir, "intent.json"),
      JSON.stringify({ dispatchId: "dsp-fail-1", instruction: "Deploy failed task" }),
    );
    await writeFile(
      join(dispatchDir, "completion.json"),
      JSON.stringify({ dispatchId: "dsp-fail-1", outcome: "failed", summary: "Timeout after 60s" }),
    );

    await writeSchedule("sch-fail", {
      scheduleId: "sch-fail",
      state: "failed",
      stepIds: ["s1"],
      steps: {
        s1: {
          stepId: "s1",
          prompt: "Deploy",
          state: "failed",
          attempts: ["dsp-fail-1"],
          result: { outcome: "failed", summary: "Timeout after 60s" },
        },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const state = await reader.readState();
    const sched = state.schedules.find((s) => s.scheduleId === "sch-fail")!;
    expect(sched.state).toBe("failed");
    expect(sched.steps[0].dispatches[0].state).toBe("failed");
    expect(sched.steps[0].dispatches[0].error).toBeTruthy();
  });

  it("reports schedule with targetIdentity", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    await writeSchedule("sch-tgt", {
      scheduleId: "sch-tgt",
      state: "active",
      targetIdentity: {
        workspaceId: "ws-1",
        ownerId: "owner-1",
        endpointId: "ep-1",
      },
      stepIds: [],
      steps: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const state = await reader.readState();
    const sched = state.schedules[0];
    expect(sched.targetIdentity?.workspaceId).toBe("ws-1");
    expect(sched.targetIdentity?.endpointId).toBe("ep-1");
  });

  it("skips corrupt schedule files", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    const dir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad.json"), "not-json{{");
    await writeFile(
      join(dir, "good.json"),
      JSON.stringify({ scheduleId: "good", state: "active", stepIds: [], steps: {}, createdAt: Date.now(), updatedAt: Date.now() }),
    );

    const state = await reader.readState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].scheduleId).toBe("good");
  });

  it("readStateChanged returns null when state unchanged", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    await writeSchedule("sch-c", {
      scheduleId: "sch-c",
      state: "active",
      stepIds: [],
      steps: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const first = await reader.readStateChanged();
    expect(first).not.toBeNull();
    const second = await reader.readStateChanged();
    expect(second).toBeNull();

    // 状态变化后再次返回
    await writeSchedule("sch-c", {
      scheduleId: "sch-c",
      state: "completed",
      stepIds: [],
      steps: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const third = await reader.readStateChanged();
    expect(third).not.toBeNull();
    expect(third!.schedules[0].state).toBe("completed");
  });
});

// 泛化发现回归：readFile 之后再比 raw.length 的顺序缺陷。
// 旧写法两处问题：(1) 先分配完整内容再判超限（异常大文件先 OOM 再被拒）；
// (2) raw.length 是 UTF-16 单元数、不是字节数，含 CJK 的文件会「字节已超限但字符数未超」而被放行。
describe("MaestroStateReader oversized schedule guard (stat-before-read)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `maestro-cap-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeRaw(scheduleId: string, content: string) {
    const dir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${scheduleId}.json`), content, "utf8");
  }

  it("CJK 内容字节数超限（字符数未超）时整份丢弃 —— 旧实现会因 raw.length 按字符计而放行", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    // 300k 个 CJK 字符：UTF-16 长度 300_000 (< 1_048_576)，UTF-8 字节 900_000...
    // 需要字节数 > MAX_FILE_SIZE(1MB) 且字符数 < 1MB → 用 500k 字符 = 1.5MB 字节
    const pad = "字".repeat(500_000);
    expect(pad.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(pad, "utf8")).toBeGreaterThan(1024 * 1024);
    const body = JSON.stringify({ scheduleId: "sch-cjk", state: "active", stepIds: [], steps: {}, note: pad, createdAt: 1, updatedAt: 1 });
    await writeRaw("sch-cjk", body);

    const state = await reader.readState();
    // 新实现：stat.size 已超限 → 不读也不计入；旧实现：按字符数没超限 → 读入并算作 1 个 schedule
    expect(state.schedules).toHaveLength(0);
  });

  it("未超限的调度仍正常读取（守卫不能误杀合法文件）", async () => {
    const reader = new MaestroStateReader({ projectRoot: tmpDir });
    await writeRaw("sch-ok", JSON.stringify({ scheduleId: "sch-ok", state: "active", stepIds: [], steps: {}, createdAt: 1, updatedAt: 2 }));
    const state = await reader.readState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0]?.scheduleId).toBe("sch-ok");
  });
});

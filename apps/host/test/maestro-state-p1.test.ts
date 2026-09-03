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

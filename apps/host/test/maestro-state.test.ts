import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MaestroStateReader } from "../src/maestro-state.js";

describe("MaestroStateReader", () => {
  let tmpDir: string;
  let reader: MaestroStateReader;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `maestro-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    reader = new MaestroStateReader({ projectRoot: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects missing maestro directory", async () => {
    expect(await reader.detectMaestro()).toBe(false);
  });

  it("detects existing maestro directory", async () => {
    await mkdir(join(tmpDir, ".pi", "flow-schedule", "v1", "schedules"), { recursive: true });
    expect(await reader.detectMaestro()).toBe(true);
  });

  it("returns empty state when no schedules exist", async () => {
    const state = await reader.readState();
    expect(state.schedules).toEqual([]);
    expect(state.observedAt).toBeTruthy();
  });

  it("reads a single completed schedule", async () => {
    const scheduleDir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(scheduleDir, { recursive: true });

    const scheduleId = "sch-001";
    const schedule = {
      version: "0.5.0",
      scheduleId,
      storeId: "test-store",
      targetSelector: "test",
      state: "completed",
      stepIds: ["step-1"],
      steps: {
        "step-1": {
          stepId: "step-1",
          prompt: "Test step prompt",
          state: "completed",
          attempts: [],
          result: {
            outcome: "completed",
            summary: "All good",
            resources: [],
          },
        },
      },
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
    };

    await writeFile(
      join(scheduleDir, `${scheduleId}.json`),
      JSON.stringify(schedule),
    );

    const state = await reader.readState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].scheduleId).toBe("sch-001");
    expect(state.schedules[0].state).toBe("completed");
    expect(state.schedules[0].progress).toEqual({ completed: 1, total: 1 });
    expect(state.schedules[0].steps).toHaveLength(1);
  });

  it("reads a multi-step active schedule with dispatches", async () => {
    const baseDir = join(tmpDir, ".pi", "flow-schedule", "v1");
    const scheduleDir = join(baseDir, "schedules");
    const dispatchDir = join(baseDir, "dispatches");
    await mkdir(scheduleDir, { recursive: true });
    await mkdir(dispatchDir, { recursive: true });

    const scheduleId = "sch-002";
    const dispatchId = "dsp-001";

    // Create dispatch intent
    const intentDir = join(dispatchDir, dispatchId);
    await mkdir(intentDir, { recursive: true });
    await writeFile(
      join(intentDir, "intent.json"),
      JSON.stringify({
        dispatchId,
        scheduleId,
        stepId: "step-1",
        targetSelector: "worker-1",
        instruction: "Run the test suite",
      }),
    );

    // Create dispatch completion
    await writeFile(
      join(intentDir, "completion.json"),
      JSON.stringify({
        dispatchId,
        outcome: "completed",
        summary: "Tests passed",
        settledAt: Date.now(),
      }),
    );

    // Create schedule
    const schedule = {
      version: "0.5.0",
      scheduleId,
      storeId: "test-store",
      targetSelector: "test",
      state: "active",
      stepIds: ["step-1", "step-2"],
      activeStepId: "step-2",
      steps: {
        "step-1": {
          stepId: "step-1",
          prompt: "Step 1: prepare",
          state: "completed",
          attempts: [dispatchId],
          result: {
            outcome: "completed",
            summary: "Step 1 done",
            resources: [],
          },
        },
        "step-2": {
          stepId: "step-2",
          prompt: "Step 2: deploy",
          state: "pending",
          attempts: [],
        },
      },
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
    };

    await writeFile(
      join(scheduleDir, `${scheduleId}.json`),
      JSON.stringify(schedule),
    );

    const state = await reader.readState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].state).toBe("active");
    expect(state.schedules[0].progress).toEqual({ completed: 1, total: 2 });
    expect(state.schedules[0].steps[0].dispatches).toHaveLength(1);
    expect(state.schedules[0].steps[0].dispatches[0].state).toBe("completed");
    expect(state.schedules[0].steps[0].dispatches[0].task).toBe("Run the test suite");
  });
});
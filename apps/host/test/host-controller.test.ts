import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("HostController", () => {
  let tmpDir: string;
  let controller: HostController;
  let reader: MaestroStateReader;
  let events: unknown[];

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `maestro-host-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    events = [];
    reader = new MaestroStateReader({ projectRoot: tmpDir });
    controller = new HostController(
      {
        createRuntime: async () => {
          throw new Error("Not implemented in test");
        },
        listSessions: async () => [],
      },
      reader,
    );
    controller.onEvent((event) => { events.push(event); });
  });

  afterEach(async () => {
    await controller.dispose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns initial status", () => {
    const status = controller.getStatus();
    expect(status.ok).toBe(true);
    expect(status.version).toBe("0.1.0");
    expect(status.sessions).toBe(0);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("starts and stops maestro poll", async () => {
    // 创建 flow-schedule 目录并写入一个调度，验证 poll 能读取
    const scheduleDir = join(tmpDir, ".pi", "flow-schedule", "v1", "schedules");
    await mkdir(scheduleDir, { recursive: true });
    await writeFile(
      join(scheduleDir, "sch-001.json"),
      JSON.stringify({
        scheduleId: "sch-001",
        state: "active",
        stepIds: [],
        steps: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await controller.startMaestroPoll(100);
    // 等待 poll 触发
    await new Promise((r) => setTimeout(r, 200));
    const maestroEvents = events.filter((e: unknown) => {
      const ev = e as { type?: string };
      return ev.type === "maestro_state";
    });
    expect(maestroEvents.length).toBeGreaterThanOrEqual(1);
    controller.stopMaestroPoll();
  });

  it("openSession returns error when runtime unavailable", async () => {
    await expect(controller.openSession({ cwd: tmpDir, mode: "create" })).rejects.toThrow();
  });

  it("getSession returns undefined for unknown session", () => {
    expect(controller.getSession("unknown")).toBeUndefined();
  });

  it("closeSession returns false for unknown session", async () => {
    expect(await controller.closeSession("unknown")).toBe(false);
  });
});
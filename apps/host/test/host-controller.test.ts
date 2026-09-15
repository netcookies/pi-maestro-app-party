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
    expect(status.version).toBe("0.3.2");
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

  it("findActiveOwnerForSession strictly routes to matching session and filters monitor window by default", async () => {
    // 构造伪造的 telemetryReader
    const fakeOwners = [
      {
        workspaceId: "ws-1",
        normalizedCwd: tmpDir,
        ownerId: "owner-monitor-62ebda",
        ownerNonce: "nonce-mon",
        pid: 1001,
        sessionId: "session-monitor",
        sessionName: "#control-62ebda",
        publishedAt: 2000, // 最新的心跳
        alive: true,
        ageMs: 100,
        contextPressure: 50,
        agents: [],
        settled: [],
        backgroundJobs: [],
      },
      {
        workspaceId: "ws-1",
        normalizedCwd: tmpDir,
        ownerId: "owner-worker-1a1f09",
        ownerNonce: "nonce-worker",
        pid: 1002,
        sessionId: "session-worker-a",
        publishedAt: 1500,
        alive: true,
        ageMs: 200,
        contextPressure: 20,
        agents: [],
        settled: [],
        backgroundJobs: [],
      },
      {
        workspaceId: "ws-1",
        normalizedCwd: tmpDir,
        ownerId: "owner-worker-e56b18",
        ownerNonce: "nonce-worker-2",
        pid: 1003,
        sessionId: "session-worker-b",
        publishedAt: 1600,
        alive: true,
        ageMs: 150,
        contextPressure: 15,
        agents: [],
        settled: [],
        backgroundJobs: [],
      },
    ];

    (controller as unknown as { telemetryReader: { read: () => Promise<{ owners: typeof fakeOwners }> } }).telemetryReader = {
      read: async () => ({ owners: fakeOwners }),
    };

    // 1. 指定 worker session，必须精准命中 worker owner，绝不命中 monitor
    const workerOwner = await controller.findActiveOwnerForSession(tmpDir, "session-worker-a");
    expect(workerOwner).toBeDefined();
    expect(workerOwner?.ownerId).toBe("owner-worker-1a1f09");

    // 2. 默认情况下（allowMonitor=false），即使传入 monitor 的 sessionId，也会被安全拦截过滤，防止业务消息注入监控窗口
    const defaultMonitorAttempt = await controller.findActiveOwnerForSession(tmpDir, "session-monitor");
    expect(defaultMonitorAttempt).toBeUndefined();

    // 3. 显式开启 allowMonitor: true 时，允许寻址 monitor 窗口（用于特定监督场景）
    const explicitMonitorOwner = await controller.findActiveOwnerForSession(tmpDir, "session-monitor", { allowMonitor: true });
    expect(explicitMonitorOwner).toBeDefined();
    expect(explicitMonitorOwner?.ownerId).toBe("owner-monitor-62ebda");

    // 4. 指定一个非桌面的未知 session，必须返回 undefined，绝对不能降级落到 monitor 窗口
    const unknownOwner = await controller.findActiveOwnerForSession(tmpDir, "session-unknown-c");
    expect(unknownOwner).toBeUndefined();

    // 5. 未指定 sessionId，但存在多个同 cwd 活跃窗口时，禁止盲猜，返回 undefined
    const ambiguousOwner = await controller.findActiveOwnerForSession(tmpDir);
    expect(ambiguousOwner).toBeUndefined();
  });
});
import { describe, expect, it } from "vitest";
import { MonitorReadService } from "../src/application/monitor-read-service.js";
import type { WorkspaceTelemetryState } from "@maestro-mobile/shared";

const owner = {
  workspaceId: "ws-1",
  normalizedCwd: "/work/app",
  ownerId: "owner-1",
  ownerNonce: "nonce-1",
  pid: 123,
  sessionId: "session-1",
  sessionName: "#control-main",
  workspaceRole: "monitor",
  publishedAt: 1000,
  contextPressure: 20,
  agents: [],
  settled: [],
  backgroundJobs: [],
  alive: true,
  ageMs: 10,
};

describe("MonitorReadService", () => {
  it("shares one projection and keeps revision stable across heartbeat-only changes", async () => {
    let telemetry: WorkspaceTelemetryState = {
      owners: [owner],
      observedAt: "2026-01-01T00:00:00.000Z",
      aliveCount: 1,
    };
    const service = new MonitorReadService(() => Promise.resolve(telemetry));

    const first = await service.read();
    telemetry = {
      ...telemetry,
      observedAt: "2026-01-01T00:00:01.000Z",
      owners: [{ ...owner, publishedAt: 2000, ageMs: 1010 }],
    };
    const second = await service.read();

    expect(first.state.windows[0]?.presentation?.visibility).toBe("monitor_tab");
    expect(second.state.revision).toBe(first.state.revision);
    expect(second.stableKey).toBe(first.stableKey);
    expect(second.state.observedAt).not.toBe(first.state.observedAt);
  });

  it("increments revision when a projected field changes", async () => {
    let telemetry: WorkspaceTelemetryState = {
      owners: [owner],
      observedAt: "2026-01-01T00:00:00.000Z",
      aliveCount: 1,
    };
    const service = new MonitorReadService(() => Promise.resolve(telemetry));
    const first = await service.read();
    telemetry = {
      ...telemetry,
      owners: [{ ...owner, mainProgress: { events: [{ kind: "lifecycle", phase: "turn_start" }] } }],
    };
    const second = await service.read();
    expect(second.state.revision).toBe(first.state.revision! + 1);
    expect(second.state.windows[0]?.status).toBe("running");
  });
});

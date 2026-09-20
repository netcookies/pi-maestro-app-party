import { afterEach, describe, expect, it } from "vitest";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import {
  beginDesktopPluginRuntimeRecord,
  clearDesktopPluginRuntimeRecord,
  getDesktopPluginRuntimeRecord,
  updateDesktopPluginRuntimeRecord,
} from "../src/plugin/desktop-plugin-runtime-state.js";
import { compareDesktopCurrentStatus, formatDesktopCurrentStatus } from "../src/current-desktop-status.js";

const target: DesktopPluginTarget = {
  sessionId: "session-1",
  endpointId: "endpoint-a",
  normalizedCwd: "/work/app",
  processGeneration: "generation-1",
};

const host = (runtimeStatus: "running" | "idle" = "running") => ({
  broker: { connected: true, projectionValid: true, brokerInstanceId: "broker-1", revision: 4 },
  targets: [{ target, runtimeStatus }],
});

function begin(generationToken = target.processGeneration, localStatus: "running" | "idle" = "running") {
  beginDesktopPluginRuntimeRecord({
    target: { ...target, processGeneration: generationToken },
    localStatus,
    pluginBroker: "connected",
    transitionAt: new Date().toISOString(),
    generationToken,
  });
}

afterEach(() => {
  const current = getDesktopPluginRuntimeRecord();
  if (current) clearDesktopPluginRuntimeRecord(current.generationToken);
});

describe("desktop current status", () => {
  it("requires all four target identity fields and reports synced state", () => {
    begin();
    const report = compareDesktopCurrentStatus({ hostReachable: true, local: getDesktopPluginRuntimeRecord(), host: host() });
    expect(report.verdict).toBe("synced");
    expect(report.expectedAppColor).toBe("green");
    expect(formatDesktopCurrentStatus(report)).toContain("SYNCED");
  });

  it("distinguishes runtime drift, missing target, and disconnected layers", () => {
    begin("generation-1", "running");
    const local = getDesktopPluginRuntimeRecord();
    expect(compareDesktopCurrentStatus({ hostReachable: true, local, host: host("idle") }).verdict).toBe("drift");
    expect(compareDesktopCurrentStatus({ hostReachable: true, local, host: { ...host(), targets: [] } }).verdict).toBe("target_missing");
    updateDesktopPluginRuntimeRecord("generation-1", { pluginBroker: "disconnected" });
    expect(compareDesktopCurrentStatus({ hostReachable: true, local: getDesktopPluginRuntimeRecord(), host: host() }).verdict).toBe("plugin_disconnected");
    expect(compareDesktopCurrentStatus({ hostReachable: true, local, host: { ...host(), broker: { ...host().broker, connected: false } } }).verdict).toBe("broker_host_disconnected");
    expect(compareDesktopCurrentStatus({ hostReachable: false, local, host: undefined }).verdict).toBe("host_unreachable");
  });

  it("does not allow an old generation to mutate or clear a newer record", () => {
    begin("generation-old");
    begin("generation-new");
    updateDesktopPluginRuntimeRecord("generation-old", { localStatus: "idle" });
    expect(getDesktopPluginRuntimeRecord()?.generationToken).toBe("generation-new");
    expect(getDesktopPluginRuntimeRecord()?.localStatus).toBe("running");
    clearDesktopPluginRuntimeRecord("generation-old");
    expect(getDesktopPluginRuntimeRecord()?.generationToken).toBe("generation-new");
    clearDesktopPluginRuntimeRecord("generation-new");
    expect(getDesktopPluginRuntimeRecord()).toBeUndefined();
  });
});

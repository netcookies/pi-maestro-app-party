import { describe, expect, it } from "vitest";
import {
  DESKTOP_PLUGIN_PROTOCOL_VERSION,
  isDesktopPluginClientFrame,
  isDesktopPluginServerFrame,
} from "../src/desktop-plugin-protocol.js";
import { validateDesktopPluginClientFrame } from "../src/validation.js";

describe("Desktop Plugin IPC protocol", () => {
  const hello = {
    type: "desktop_plugin_hello" as const,
    protocolVersion: DESKTOP_PLUGIN_PROTOCOL_VERSION,
    endpointId: "endpoint-1",
    sessionId: "session-1",
    normalizedCwd: "/work/app",
    processGeneration: "generation-1",
    capabilities: ["prompt", "abort"] as const,
    clientNonce: "nonce-1",
    secret: "secret-1",
  };

  it("accepts authenticated identity and capability fields", () => {
    expect(isDesktopPluginClientFrame(hello)).toBe(true);
    expect(() => validateDesktopPluginClientFrame(hello)).not.toThrow();
    expect(isDesktopPluginClientFrame({ ...hello, processGeneration: "" })).toBe(false);
  });

  it("requires exact target identity for side effects", () => {
    const request = {
      type: "desktop_plugin_request" as const,
      requestId: "request-1",
      commandId: "command-1",
      deadlineAt: Date.now() + 1000,
      target: {
        sessionId: "session-1",
        endpointId: "endpoint-1",
        normalizedCwd: "/work/app",
        processGeneration: "generation-1",
      },
      operation: { type: "abort" as const },
    };
    expect(isDesktopPluginClientFrame(request)).toBe(true);
    expect(isDesktopPluginClientFrame({ ...request, target: { ...request.target, endpointId: "other" } })).toBe(true);
    expect(isDesktopPluginClientFrame({ ...request, target: { ...request.target, processGeneration: "" } })).toBe(false);
  });

  it("accepts receipts/results and rejects unsupported server frames", () => {
    expect(isDesktopPluginServerFrame({
      type: "desktop_plugin_receipt",
      requestId: "request-1",
      operation: "abort",
      status: "accepted",
    })).toBe(true);
    expect(isDesktopPluginServerFrame({
      type: "desktop_plugin_result",
      requestId: "request-1",
      operation: "abort",
      status: "observed",
      result: { cancelled: true },
    })).toBe(true);
    expect(isDesktopPluginServerFrame({ type: "desktop_plugin_receipt", status: "observed" })).toBe(false);
  });
});

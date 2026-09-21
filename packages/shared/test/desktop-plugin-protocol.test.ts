import { describe, expect, it } from "vitest";
import {
  DESKTOP_PLUGIN_PROTOCOL_VERSION,
  isDesktopPluginClientFrame,
  isDesktopPluginServerFrame,
} from "../src/desktop-plugin-protocol.js";
import { validateDesktopPluginClientFrame } from "../src/validation.js";
import {
  DESKTOP_BROKER_PROTOCOL_VERSION,
  isDesktopBrokerToHostFrame,
  isDesktopHostToBrokerFrame,
} from "../src/desktop-broker-protocol.js";

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

  it("accepts authenticated identity and optional session metadata", () => {
    expect(isDesktopPluginClientFrame(hello)).toBe(true);
    expect(() => validateDesktopPluginClientFrame(hello)).not.toThrow();
    expect(isDesktopPluginClientFrame({ ...hello, sessionFile: "/sessions/session-1.jsonl" })).toBe(true);
    expect(isDesktopPluginClientFrame({ ...hello, sessionFile: "" })).toBe(false);
    expect(isDesktopPluginClientFrame({ ...hello, processGeneration: "" })).toBe(false);
  });

  it("rejects the retired Plugin protocol v1 hello", () => {
    expect(isDesktopPluginClientFrame({ ...hello, protocolVersion: 1 })).toBe(false);
  });

  it("accepts ready frames and validates advertised event support", () => {
    const ready = {
      type: "desktop_plugin_ready" as const,
      protocolVersion: DESKTOP_PLUGIN_PROTOCOL_VERSION,
      endpointId: "endpoint-1",
      capabilities: ["prompt"],
    };
    expect(isDesktopPluginServerFrame(ready)).toBe(true);
    expect(isDesktopPluginServerFrame({ ...ready, supportedEvents: ["model_select", "thinking_level_select", "runtime_status"] })).toBe(true);
    expect(isDesktopPluginServerFrame({ ...ready, supportedEvents: ["unknown_event"] })).toBe(false);
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

  it("accepts model and thinking operations plus their state events", () => {
    const target = {
      sessionId: "session-1",
      endpointId: "endpoint-1",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_request",
      requestId: "request-model",
      commandId: "command-model",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "set_model", provider: "provider-a", modelId: "shared-id" },
    })).toBe(true);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_request",
      requestId: "request-thinking",
      commandId: "command-thinking",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "set_thinking", level: "high" },
    })).toBe(true);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_request",
      requestId: "request-list-models",
      commandId: "command-list-models",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "list_models" },
    })).toBe(true);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_request",
      requestId: "request-list-skills",
      commandId: "command-list-skills",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "list_skills" },
    })).toBe(true);

    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_event",
      event: "thinking_level_select",
      level: "xhigh",
    })).toBe(true);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_event",
      event: "runtime_status",
      runtimeStatus: "running",
    })).toBe(true);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_event",
      event: "runtime_status",
      runtimeStatus: "history",
    })).toBe(false);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_event",
      event: "session_summary",
      summary: {
        runtimeStatus: "running",
        activeSince: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:01.000Z",
        messageCount: 2,
        context: { tokens: 5, contextWindow: 10, percent: 50 },
      },
    })).toBe(true);
  });

  it("validates broker snapshots, deltas, and exact-target commands", () => {
    const target = {
      sessionId: "session-1",
      endpointId: "endpoint-1",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    const record = {
      target,
      sessionFile: "/sessions/session-1.jsonl",
      capabilities: ["prompt", "abort", "set_thinking", "list_models", "list_skills"],
      thinkingLevel: "medium",
      runtimeStatus: "idle" as const,
      summary: { runtimeStatus: "idle" as const, messageCount: 2 },
    };
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_hello",
      protocolVersion: DESKTOP_BROKER_PROTOCOL_VERSION,
      brokerInstanceId: "broker-1",
      clientNonce: "nonce-1",
      secret: "secret-1",
    })).toBe(true);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_snapshot_chunk",
      brokerInstanceId: "broker-1",
      snapshotId: "snapshot-1",
      revision: 1,
      chunkIndex: 0,
      records: [record],
    })).toBe(true);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_snapshot_chunk",
      brokerInstanceId: "broker-1",
      snapshotId: "snapshot-1",
      revision: 1,
      chunkIndex: 0,
      records: [{ ...record, sessionFile: "" }],
    })).toBe(false);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_snapshot_chunk",
      brokerInstanceId: "broker-1",
      snapshotId: "snapshot-legacy",
      revision: 1,
      chunkIndex: 0,
      records: [{ ...record, thinkingLevel: undefined }],
    })).toBe(true);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_delta",
      brokerInstanceId: "broker-1",
      baseRevision: 1,
      revision: 2,
      mutation: { kind: "thinking_level", target, level: "high" },
    })).toBe(true);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_delta",
      brokerInstanceId: "broker-1",
      baseRevision: 2,
      revision: 3,
      mutation: { kind: "thinking_level", target, level: "" },
    })).toBe(false);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_delta",
      brokerInstanceId: "broker-1",
      baseRevision: 1,
      revision: 2,
      mutation: { kind: "runtime_status", target, runtimeStatus: "running" },
    })).toBe(true);
    expect(isDesktopBrokerToHostFrame({
      type: "desktop_broker_delta",
      brokerInstanceId: "broker-1",
      baseRevision: 1,
      revision: 3,
      mutation: { kind: "runtime_status", target, runtimeStatus: "running" },
    })).toBe(false);
    expect(isDesktopHostToBrokerFrame({
      type: "desktop_broker_command",
      request: {
        type: "desktop_plugin_request",
        requestId: "request-1",
        commandId: "command-1",
        deadlineAt: Date.now() + 1000,
        target,
        operation: { type: "abort" },
      },
    })).toBe(true);
    for (const operation of [{ type: "list_models" as const }, { type: "list_skills" as const }]) {
      expect(isDesktopHostToBrokerFrame({
        type: "desktop_broker_command",
        request: {
          type: "desktop_plugin_request",
          requestId: `request-${operation.type}`,
          commandId: `command-${operation.type}`,
          deadlineAt: Date.now() + 1000,
          target,
          operation,
        },
      })).toBe(true);
    }
    expect(isDesktopHostToBrokerFrame({
      type: "desktop_broker_command",
      request: {
        type: "desktop_plugin_request",
        requestId: "request-1",
        commandId: "command-1",
        deadlineAt: Date.now() + 1000,
        target: { ...target, processGeneration: "" },
        operation: { type: "abort" },
      },
    })).toBe(false);
  });

  it("accepts accepted results for asynchronous user delivery", () => {
    expect(isDesktopPluginServerFrame({
      type: "desktop_plugin_result",
      requestId: "request-prompt",
      operation: "prompt",
      status: "accepted",
    })).toBe(true);
    expect(isDesktopPluginServerFrame({
      type: "desktop_plugin_result",
      requestId: "request-prompt",
      operation: "prompt",
      status: "observed",
    })).toBe(true);
  });

  it("accepts correlated ask results and rejects incomplete receipts", () => {
    const result = {
      type: "desktop_ask_result" as const,
      requestId: "question:tool-1",
      toolCallId: "tool-1",
      status: "accepted" as const,
    };
    expect(isDesktopPluginClientFrame(result)).toBe(true);
    expect(isDesktopPluginClientFrame({ ...result, toolCallId: "" })).toBe(false);
    const target = {
      sessionId: "session-1",
      endpointId: "endpoint-1",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    expect(isDesktopBrokerToHostFrame({ type: "desktop_broker_ask_result", target, result })).toBe(true);
    expect(isDesktopBrokerToHostFrame({ type: "desktop_broker_ask_result", target, result: { ...result, status: "failed", error: { code: "deadline_exceeded" } } })).toBe(true);
  });

  it("rejects malformed model and thinking operations and events", () => {
    const target = {
      sessionId: "session-1",
      endpointId: "endpoint-1",
      normalizedCwd: "/work/app",
      processGeneration: "generation-1",
    };
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_event",
      event: "model_select",
      model: { provider: "", id: "model", name: "Model", reasoning: true, vision: false },
    })).toBe(false);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_event",
      event: "thinking_level_select",
      level: "",
    })).toBe(false);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_request",
      requestId: "request-thinking",
      commandId: "command-thinking",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "set_thinking", level: "" },
    })).toBe(false);
    expect(isDesktopPluginClientFrame({
      type: "desktop_plugin_request",
      requestId: "request-model",
      commandId: "command-model",
      deadlineAt: Date.now() + 1000,
      target,
      operation: { type: "set_model", provider: "provider-a", modelId: "" },
    })).toBe(false);
  });
});

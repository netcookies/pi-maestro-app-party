import { describe, expect, it } from "vitest";
import {
  CommandConnectionLostError,
  CommandFailedError,
  createMobileClient,
  type WebSocketLike,
} from "../src/client.js";

import { isSessionPresentation } from "../src/protocol/index.js";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("SessionPresentation contract", () => {
  const presentation = { role: "session", visibility: "session_list", revision: 1,
    control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false,
      canAbort: false, canAnswerAsk: false, canPlan: false } };
  it("accepts canonical control and rejects obsolete modes or incomplete fields", () => {
    expect(isSessionPresentation(presentation)).toBe(true);
    expect(isSessionPresentation({ ...presentation, revision: -1 })).toBe(false);
    expect(isSessionPresentation({ ...presentation, control: { ...presentation.control, mode: "host" } })).toBe(false);
    expect(isSessionPresentation({ ...presentation, control: { ...presentation.control, canPlan: undefined } })).toBe(false);
  });
});

describe("MobileClient", () => {
  it("negotiates protocol independently of product and SDK versions", () => {
    const socket = new FakeSocket();
    const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => socket, clientVersion: "9.9.9", sdkVersion: "8.8.8" });
    client.connect();
    socket.open();
    const hello = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    expect(hello.protocolVersion).toBe(2);
    expect(hello.clientVersion).toBe("9.9.9");
    expect(hello.sdkVersion).toBe("8.8.8");
    socket.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "7.7.7", sdkVersion: "1.0.0", capabilities: [], revision: 1, releaseVersion: "0.1.0" });
    expect(client.isProtocolReady).toBe(true);
    client.dispose();
  });

  it("rejects an unsupported protocol revision", () => {
    const socket = new FakeSocket();
    const errors: string[] = [];
    const client = createMobileClient({
      url: "ws://host/ws",
      wsFactory: () => socket,
      onConnectionError: (message) => errors.push(message),
    });
    client.connect();
    socket.open();
    socket.receive({ type: "protocol_ready", protocolVersion: 2, protocolRevision: 1, hostVersion: "1.0.0", capabilities: [], revision: 1 });
    expect(client.isProtocolReady).toBe(false);
    expect(errors).toEqual(["invalid or incompatible protocol_ready frame"]);
    client.dispose();
  });

  it("correlates command results and settles in-flight commands on disconnect", async () => {
    const socket = new FakeSocket();
    const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => socket, reconnectBaseMs: 60_000 });
    client.connect();
    socket.open();
    socket.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1.0.0", capabilities: [], revision: 1 });

    const command = client.sendCommand({ type: "ping" });
    const frame = JSON.parse(socket.sent[1]) as { id: string };
    socket.receive({ type: "command_result", in_reply_to: frame.id, ok: true, status: "accepted", revision: 2, result: { ok: true } });
    await expect(command).resolves.toEqual({ ok: true });

    const pending = client.sendCommand({ type: "ping" });
    socket.close();
    await expect(pending).rejects.toBeInstanceOf(CommandConnectionLostError);
    client.dispose();
  });

  it("ignores malformed event and result frames without consuming a pending request", async () => {
    const socket = new FakeSocket();
    const events: unknown[] = [];
    const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => socket, onEvent: (event) => events.push(event) });
    client.connect();
    socket.open();
    socket.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1.0.0", capabilities: [], revision: 1 });
    socket.receive({ type: "extension_ui_request", seq: 1 });
    socket.receive({ type: "session_error", sessionId: "s", error: {}, seq: 2 });
    socket.receive({ type: "unknown_event", seq: 3 });
    expect(events).toEqual([]);

    const command = client.sendCommand({ type: "ping" });
    const { id } = JSON.parse(socket.sent[1]) as { id: string };
    socket.receive({ type: "command_result", in_reply_to: id, ok: true });
    socket.receive({ type: "command_result", in_reply_to: id, ok: true, status: "observed", revision: 2, result: "valid" });
    await expect(command).resolves.toBe("valid");
    client.dispose();
  });

  it("preserves structured command errors for consumers", async () => {
    const socket = new FakeSocket();
    const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => socket });
    client.connect();
    socket.open();
    socket.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1.0.0", capabilities: [], revision: 1 });
    const command = client.sendCommand({ type: "ping" });
    const { id } = JSON.parse(socket.sent[1]) as { id: string };
    const details = { code: "provider_unavailable", message: "offline", source: "provider", httpStatus: 503 };
    socket.receive({ type: "command_result", in_reply_to: id, ok: false, status: "failed", revision: 2,
      error: { code: "delivery_failed", message: "missing_model_auth", details } });
    await expect(command).rejects.toBeInstanceOf(CommandFailedError);
    await expect(command).rejects.toMatchObject({ code: "delivery_failed", message: "missing_model_auth", status: "failed", revision: 2, requestId: id, details });
    client.dispose();
  });

  it("ignores an old socket close after reconnectNow establishes a newer generation", () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => sockets.shift()! });
    client.connect();
    first.open();
    first.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1.0.0", capabilities: [], revision: 1 });
    client.reconnectNow();
    second.open();
    second.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1.0.0", capabilities: [], revision: 2 });
    expect(client.isProtocolReady).toBe(true);
    first.onclose?.();
    expect(client.isProtocolReady).toBe(true);
    expect(client.connectionState).toBe("connected");
    client.dispose();
  });
  it("removes event listeners on unsubscribe and dispose", () => {
    const socket = new FakeSocket();
    const events: string[] = [];
    const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => socket });
    const off = client.onEvent((event) => events.push(event.type));
    client.connect();
    socket.open();
    socket.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1.0.0", capabilities: [], revision: 1 });
    socket.receive({ type: "host_status", status: "ok", seq: 1 });
    off();
    socket.receive({ type: "host_status", status: "ignored", seq: 2 });
    expect(events).toEqual(["host_status"]);
    client.dispose();
  });
});

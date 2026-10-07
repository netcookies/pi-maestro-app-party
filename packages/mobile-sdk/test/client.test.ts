import { describe, expect, it } from "vitest";
import {
  CommandConnectionLostError,
  createMobileClient,
  type WebSocketLike,
} from "../src/client.js";

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

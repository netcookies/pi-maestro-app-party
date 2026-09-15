import { describe, expect, it } from "vitest";
import {
  MOBILE_PROTOCOL_VERSION,
  isClientCommand,
  isClientFrame,
  isHostFrame,
  isProtocolHello,
  type ClientCommand,
} from "../src/protocol.js";
import {
  validateClientFrame,
  validateDesktopPluginClientFrame,
  validateHostFrame,
  validateProtocolHello,
} from "../src/validation.js";

describe("Protocol v2 frames", () => {
  it("accepts the required hello and rejects another protocol version", () => {
    const hello = {
      type: "protocol_hello",
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      clientVersion: "0.5.0",
      capabilities: ["session_control"],
      requestId: "hello-1",
    } as const;
    expect(isProtocolHello(hello)).toBe(true);
    expect(isClientFrame(hello)).toBe(true);
    expect(() => validateProtocolHello(hello)).not.toThrow();
    expect(isProtocolHello({ ...hello, protocolVersion: 1 })).toBe(false);
    expect(() => validateClientFrame({ type: "ping" })).not.toThrow();
  });

  it("requires discriminant-specific command fields", () => {
    const command: ClientCommand = { type: "abort", sessionId: "session-1", id: "cmd-1" };
    expect(isClientCommand(command)).toBe(true);
    expect(isClientCommand({ type: "abort" })).toBe(false);
    expect(isClientCommand({ type: "not-a-command" })).toBe(false);
    expect(isClientCommand({ type: "prompt", sessionId: "s1", message: 42 })).toBe(false);
  });

  it("validates typed host results and rejects legacy untyped frames", () => {
    const ready = {
      type: "protocol_ready",
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      hostVersion: "0.5.0",
      capabilities: ["monitor_read"],
      revision: 1,
    };
    const result = {
      type: "command_result",
      in_reply_to: "cmd-1",
      ok: true,
      status: "accepted",
      revision: 2,
      result: { accepted: true },
      seq: 1,
    };
    expect(isHostFrame(ready)).toBe(true);
    expect(isHostFrame(result)).toBe(true);
    expect(() => validateHostFrame(ready)).not.toThrow();
  });
});

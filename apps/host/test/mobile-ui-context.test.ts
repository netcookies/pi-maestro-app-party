import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MobileExtensionUiBridge } from "../src/mobile-ui-context.js";
import type { ExtensionUiRequest, HostEvent } from "@maestro-mobile/shared";

describe("MobileExtensionUiBridge", () => {
  let bridge: MobileExtensionUiBridge;
  let events: HostEvent[];
  let emit: (event: HostEvent) => void;
  let seq = 0;

  beforeEach(() => {
    events = [];
    seq = 0;
    emit = (event) => {
      events.push({ ...event, seq: ++seq });
    };
    bridge = new MobileExtensionUiBridge("session-1", emit);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits extension_ui_request for select dialog", async () => {
    const ctx = bridge.createContext();
    const promise = ctx.select("Pick one", ["A", "B", "C"]);
    await Promise.resolve();
    expect(events.length).toBe(1);
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    expect(req.type).toBe("extension_ui_request");
    expect(req.request.method).toBe("select");
    expect(req.request.title).toBe("Pick one");
    expect(req.request.options).toEqual(["A", "B", "C"]);
    expect(req.sessionId).toBe("session-1");

    // 用户选择
    const reqId = req.request.id;
    bridge.respond(reqId, { id: reqId, selected: ["B"] });
    const result = await promise;
    expect(result).toBe("B");
    expect(bridge.pendingCount).toBe(0);
  });

  it("emits extension_ui_request for input dialog and resolves text", async () => {
    const ctx = bridge.createContext();
    const promise = ctx.input("Your name", "Enter name");
    await Promise.resolve();
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    expect(req.request.method).toBe("input");

    bridge.respond(req.request.id, { id: req.request.id, value: "Alice" });
    expect(await promise).toBe("Alice");
  });

  it("emits extension_ui_request for confirm dialog", async () => {
    const ctx = bridge.createContext();
    const promise = ctx.confirm("Sure?", "Are you sure?");
    await Promise.resolve();
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    expect(req.request.method).toBe("confirm");

    bridge.respond(req.request.id, { id: req.request.id, confirmed: true });
    expect(await promise).toBe(true);
  });

  it("resolves undefined on cancel", async () => {
    const ctx = bridge.createContext();
    const promise = ctx.input("Name");
    await Promise.resolve();
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    bridge.respond(req.request.id, { id: req.request.id, cancelled: true });
    expect(await promise).toBeUndefined();
  });

  it("auto-cancels on timeout", async () => {
    vi.useFakeTimers();
    const ctx = bridge.createContext();
    const promise = ctx.select("Pick", ["A"], { timeout: 1000 });
    await Promise.resolve();
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    expect(bridge.pendingCount).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await promise).toBeUndefined();
    expect(bridge.pendingCount).toBe(0);
  });

  it("cancelAll cancels all pending dialogs", async () => {
    const ctx = bridge.createContext();
    const p1 = ctx.select("Q1", ["A"]);
    const p2 = ctx.input("Q2");
    await Promise.resolve();
    expect(bridge.pendingCount).toBe(2);
    const cancelled = bridge.cancelAll();
    expect(cancelled).toBe(2);
    expect(await p1).toBeUndefined();
    expect(await p2).toBeUndefined();
    expect(bridge.pendingCount).toBe(0);
  });

  it("notify is fire-and-forget", async () => {
    const ctx = bridge.createContext();
    ctx.notify("Hello", "info");
    expect(events.length).toBe(1);
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    expect(req.request.method).toBe("notify");
    expect(req.request.message).toBe("Hello");
  });

  it("emits extension_ui_cleared on respond", async () => {
    const ctx = bridge.createContext();
    void ctx.input("Name");
    await Promise.resolve();
    const req = events[0] as Extract<HostEvent, { type: "extension_ui_request" }>;
    bridge.respond(req.request.id, { id: req.request.id, value: "Bob" });
    const cleared = events[1] as Extract<HostEvent, { type: "extension_ui_cleared" }>;
    expect(cleared.type).toBe("extension_ui_cleared");
    expect(cleared.requestId).toBe(req.request.id);
  });

  it("respond to unknown request returns false", () => {
    expect(bridge.respond("unknown", { id: "unknown", cancelled: true })).toBe(false);
  });
});
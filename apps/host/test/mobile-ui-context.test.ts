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

  it("S_CONFIRM RV-001: host 超时也发 extension_ui_cleared（否则移动端会 reopen 无人接收的 ask）", async () => {
    vi.useFakeTimers();
    const ctx = bridge.createContext();
    const promise = ctx.select("Pick", ["A"], { timeout: 1000 });
    await Promise.resolve();
    expect(events.map((e) => e.type)).toEqual(["extension_ui_request"]);
    vi.advanceTimersByTime(1001);
    expect(await promise).toBeUndefined();
    // 修复前：超时只 delete + resolve(cancelled)，不发 cleared ⇒ 移动端弹窗永不消失
    expect(events.map((e) => e.type)).toEqual(["extension_ui_request", "extension_ui_cleared"]);
    const cleared = events[1] as Extract<HostEvent, { type: "extension_ui_cleared" }>;
    expect(cleared.requestId).toBe((events[0] as Extract<HostEvent, { type: "extension_ui_request" }>).request.id);
    vi.useRealTimers();
  });

  it("S_CONFIRM RV-001: cancelAll 为每个挂起弹窗发 cleared，且 requestId 与请求一一对应", async () => {
    const ctx = bridge.createContext();
    const p1 = ctx.select("Q1", ["A"]);
    const p2 = ctx.input("Q2");
    await Promise.resolve();
    const requestIds = events
      .filter((e) => e.type === "extension_ui_request")
      .map((e) => (e as Extract<HostEvent, { type: "extension_ui_request" }>).request.id);
    expect(requestIds).toHaveLength(2);
    events.length = 0; // 只看 cancelAll 期间产生的事件
    expect(bridge.cancelAll()).toBe(2);
    const clearedIds = events
      .filter((e) => e.type === "extension_ui_cleared")
      .map((e) => (e as Extract<HostEvent, { type: "extension_ui_cleared" }>).requestId);
    // 精确对应：不是「有两条 cleared」而已，id 必须就是那两个请求
    expect(clearedIds.sort()).toEqual(requestIds.sort());
    await Promise.all([p1, p2]);
  });

  it("S_CONFIRM RV-003: cancelAll 中单条 emit 抛错不得留下未取消条目、也不得吞掉其余通知", async () => {
    // 上一版在 for-of 里边遍历边 emitCleared，末尾才 clear() ⇒ 某次 emit 抛错就会
    // 中断循环：剩余弹窗仍留在 Map（timeout 会事后再触发一次重复取消）。
    const throwing = new MobileExtensionUiBridge(
      "session-throw",
      (event) => {
        if (event.type === "extension_ui_cleared") throw new Error("emit exploded");
        events.push(event);
      },
    );
    const ctx = throwing.createContext();
    const p1 = ctx.select("Q1", ["A"]);
    const p2 = ctx.input("Q2");
    await Promise.resolve();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let cancelled = 0;
    expect(() => { cancelled = throwing.cancelAll(); }).not.toThrow();
    expect(cancelled).toBe(2);
    expect(throwing.pendingCount, "cancelAll 后必须恒为 0，与 emit 是否抛错无关").toBe(0);
    // 两条通知都尝试过（不是抛一次就放弃其余）
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    warn.mockRestore();
    expect(await p1).toBeUndefined();
    expect(await p2).toBeUndefined();
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
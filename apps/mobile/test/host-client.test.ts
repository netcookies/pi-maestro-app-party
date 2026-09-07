import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { HostClient, type WebSocketLike } from "../src/host-client.js";
import type { ClientCommand, HostEvent } from "@maestro-mobile/shared";

const WS_OPEN = 1;

function createFakeWs(): WebSocketLike & {
  _open: () => void;
  _message: (data: unknown) => void;
  _close: () => void;
  _sent: string[];
} {
  let onopen: (() => void) | null = null;
  let onmessage: ((data: { data: unknown }) => void) | null = null;
  let onclose: (() => void) | null = null;
  const sent: string[] = [];
  const ws = {
    readyState: WS_OPEN,
    send: (data: string) => { sent.push(data); },
    close: () => { onclose?.(); },
    get onopen() { return onopen; },
    set onopen(fn) { onopen = fn; },
    get onmessage() { return onmessage; },
    set onmessage(fn) { onmessage = fn; },
    get onclose() { return onclose; },
    set onclose(fn) { onclose = fn; },
    onerror: null,
    _open: () => onopen?.(),
    _message: (data: unknown) => onmessage?.({ data }),
    _close: () => onclose?.(),
    _sent: sent,
  };
  return ws;
}

describe("HostClient", () => {
  let client: HostClient;
  let events: HostEvent[];
  let fakeWs: ReturnType<typeof createFakeWs>;

  beforeEach(() => {
    events = [];
    fakeWs = createFakeWs();
    client = new HostClient({
      url: "ws://localhost:0",
      wsFactory: () => fakeWs,
      onEvent: (e) => { events.push(e); },
    });
  });

  afterEach(() => {
    client.close();
  });

  it("connects and transitions to connected state", () => {
    expect(client.connectionState).toBe("disconnected");
    client.connect();
    expect(client.connectionState).toBe("connecting");
    fakeWs._open();
    expect(client.connectionState).toBe("connected");
    expect(client.isConnected).toBe(true);
  });

  it("receives and dispatches host events", () => {
    client.connect();
    fakeWs._open();
    fakeWs._message(JSON.stringify({ type: "host_status", status: "running", seq: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("host_status");
  });

  it("sends command and resolves on response", async () => {
    client.connect();
    fakeWs._open();
    const promise = client.sendCommand({ type: "abort", sessionId: "s1" });
    expect(fakeWs._sent).toHaveLength(1);
    const sent = JSON.parse(fakeWs._sent[0]) as ClientCommand & { id: string };
    expect(sent.type).toBe("abort");
    expect(sent.id).toBeTruthy();

    // 模拟服务器响应
    fakeWs._message(JSON.stringify({
      type: "command_result",
      in_reply_to: sent.id,
      ok: true,
      result: { closed: true },
    }));

    const result = await promise;
    expect(result).toEqual({ closed: true });
  });

  it("rejects command on error response", async () => {
    client.connect();
    fakeWs._open();
    const promise = client.sendCommand({ type: "close_session", sessionId: "s1" });
    const sent = JSON.parse(fakeWs._sent[0]) as { id: string };
    fakeWs._message(JSON.stringify({
      type: "command_result",
      in_reply_to: sent.id,
      ok: false,
      error: { code: "session_not_found", message: "Session not found" },
    }));
    await expect(promise).rejects.toThrow("Session not found");
  });

  it("reconnects on close", async () => {
    vi.useFakeTimers();
    client.connect();
    fakeWs._open();
    expect(client.connectionState).toBe("connected");
    fakeWs._close();
    expect(client.connectionState).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    // 新连接应自动创建
    expect(client.connectionState).toBe("reconnecting");
    vi.useRealTimers();
  });

  it("does not reconnect after explicit close", () => {
    client.connect();
    fakeWs._open();
    client.close();
    expect(client.connectionState).toBe("disconnected");
    // 第二次 close 不触发重连
    fakeWs._close();
    expect(client.connectionState).toBe("disconnected");
  });

  it("respondExtensionUi sends correct command", async () => {
    client.connect();
    fakeWs._open();
    const promise = client.respondExtensionUi("s1", "req-1", { id: "req-1", selected: ["A"] });
    expect(fakeWs._sent).toHaveLength(1);
    const sent = JSON.parse(fakeWs._sent[0]) as { type: string; sessionId: string; requestId: string; id: string };
    expect(sent.type).toBe("extension_ui_response");
    expect(sent.sessionId).toBe("s1");
    expect(sent.requestId).toBe("req-1");
    // 模拟服务器响应，用实际发送的命令 id
    fakeWs._message(JSON.stringify({
      type: "command_result",
      in_reply_to: sent.id,
      ok: true,
      result: null,
    }));
    await promise;
  });

  it("attaches token to ws url when provided (P1-5 跨域依赖)", () => {
    let capturedUrl = "";
    const ws = createFakeWs();
    const c = new HostClient({
      url: "ws://192.168.1.5:4739/ws",
      token: "secret",
      wsFactory: (url) => {
        capturedUrl = url;
        return ws;
      },
    });
    c.connect();
    expect(capturedUrl).toBe(`ws://192.168.1.5:4739/ws?token=${encodeURIComponent("secret")}`);
    c.close();
  });

  it("token 错误：从未连上且反复立即被断 → 停止重连并报明确错误", () => {
    vi.useFakeTimers();
    const ws = createFakeWs();
    const c = new HostClient({
      url: "ws://192.168.1.5:4739/ws",
      token: "wrong",
      wsFactory: () => ws,
      onEvent: (e) => { events.push(e); },
    });
    c.connect();
    // 第一次连接：2s 内被断（模拟 401 升级拒绝）—— 首次仍会重试（可能 host 未启动）
    ws._close();
    expect(c.connectionState).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    // 第二次立即又断：命中 authFailed 启发式（从未 onopen + 反复立即断）
    ws._close();
    expect(c.connectionState).toBe("disconnected");
    expect(events.some((e) => e.type === "error")).toBe(true);
    // 不再重连：时间前进也不再拉起
    vi.advanceTimersByTime(30_000);
    expect(c.connectionState).toBe("disconnected");
    vi.useRealTimers();
    c.close();
  });

  it("首次连接被断不误判 token 错误（host 可能未启动）", () => {
    vi.useFakeTimers();
    const ws = createFakeWs();
    const c = new HostClient({
      url: "ws://192.168.1.5:4739/ws",
      wsFactory: () => ws,
      onEvent: (e) => { events.push(e); },
    });
    c.connect();
    ws._close();
    expect(c.connectionState).toBe("reconnecting");
    expect(events.some((e) => e.type === "error" && String((e as { message?: string }).message ?? "").includes("token"))).toBe(false);
    vi.useRealTimers();
    c.close();
  });
});
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  calculateBackoffDelay,
  CommandConnectionLostError,
  HostClient,
  type WebSocketLike,
} from "../src/host-client.js";
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

  it("token 错误：反复快速被断 + health 401 → 停止重连并报明确错误", async () => {
    // fetch mock：health 返回 401（host 在，token 错）
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    const ws = createFakeWs();
    const localErrors: string[] = [];
    const c = new HostClient({
      url: "ws://192.168.1.5:4739/ws",
      token: "wrong",
      wsFactory: () => ws,
      onEvent: (e) => { events.push(e); },
      onConnectionError: (m) => { localErrors.push(m); },
    });
    c.connect();
    // 第一次被断：attempt=0 不标记（可能 host 未启动）
    ws._close();
    expect(c.connectionState).toBe("reconnecting");
    // 第二次快速被断：attempt>=1 → 疑似 → health 探测确认
    ws._close();
    // 等待 verifyAuthFailure 完成后确认 authFailed
    await vi.waitFor(() => expect(c.connectionState).toBe("disconnected"));
    // RV-002：auth 失败走本地错误通道，不再向 host 事件流投一个缺 seq 的 error 帧
    expect(localErrors.some((m) => m.includes("token"))).toBe(true);
    expect(events.some((e) => e.type === "error"), "onEvent 不得再收到无 seq 的合成 error 帧").toBe(false);
    // 既有 UI 契约：消息含 "token"，HostConnectCard.tsx:50 据此做红字强调
    expect(localErrors[0]).toContain("token");
    // 不再重连：等待 30s 等效验证（真实定时器已被 authFailed 停止，state 不变即可）
    await new Promise((r) => setTimeout(r, 50));
    expect(c.connectionState).toBe("disconnected");
    fetchMock.mockRestore();
    c.close();
  });

  it("host 未启动（refused）：反复快速失败但 health 探测失败 → 继续重连不误报", async () => {
    // fetch mock：网络不通（fetch reject）
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("refused"));
    vi.useFakeTimers();
    const ws = createFakeWs();
    const c = new HostClient({
      url: "ws://192.168.1.5:4739/ws",
      wsFactory: () => ws,
      onEvent: (e) => { events.push(e); },
    });
    c.connect();
    ws._close();
    await Promise.resolve(); // 让 verifyAuthFailure 走 catch 分支
    expect(events.some((e) => e.type === "error" && String((e as { message?: string }).message ?? "").includes("token"))).toBe(false);
    expect(c.connectionState).toBe("reconnecting");
    vi.useRealTimers();
    fetchMock.mockRestore();
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

/**
 * ISS-20260910-002：意外断连必须立即 settle 在途命令，且错误语义可与「业务失败」区分。
 * 反向验证：回滚 onclose 的 rejectAllPending 后，前两条以 30s timeout 文案失败。
 */
describe("HostClient 意外断连时 settle 在途命令（ISS-002）", () => {
  let client: HostClient;
  let fakeWs: ReturnType<typeof createFakeWs>;

  beforeEach(() => {
    fakeWs = createFakeWs();
    client = new HostClient({
      url: "ws://localhost:0",
      wsFactory: () => fakeWs,
      onEvent: () => {},
    });
  });
  afterEach(() => { client.close(); });

  it("onclose 立即以 connection_lost 拒绝在途命令，不等 30s 超时", async () => {
    client.connect();
    fakeWs._open();
    const promise = client.sendCommand({ type: "abort", sessionId: "s1" });
    let settled: Error | undefined;
    void promise.catch((e: Error) => { settled = e; });

    fakeWs._close();            // 意外断连（未调 close()）
    await Promise.resolve();    // 让 rejection 回调落地
    expect(settled, "断连后必须立即失败，而非挂满 30s timer").toBeInstanceOf(CommandConnectionLostError);
    expect((settled as unknown as { code?: string }).code).toBe("connection_lost");
    // 文案必须可区分：不得是 "Command timeout"
    expect(settled!.message).not.toContain("timeout");
  });

  it("全部在途命令都被拒绝（不是只拒第一条）", async () => {
    client.connect();
    fakeWs._open();
    const a = client.sendCommand({ type: "abort", sessionId: "s1" });
    const b = client.sendCommand({ type: "list_models", sessionId: "s1" });
    const c = client.sendCommand({ type: "get_monitor_state" });
    const errs: unknown[] = [];
    void a.catch((e: unknown) => errs.push(e));
    void b.catch((e: unknown) => errs.push(e));
    void c.catch((e: unknown) => errs.push(e));
    fakeWs._close();
    await Promise.resolve();
    expect(errs).toHaveLength(3);
    expect(errs.every((e) => e instanceof CommandConnectionLostError)).toBe(true);
    // 每条错误带自己的命令类型，便于 UI/日志区分是哪条命令状态未知
    expect(errs.map((e) => (e as CommandConnectionLostError).message).sort()).toEqual([
      "Connection lost before response (abort)",
      "Connection lost before response (get_monitor_state)",
      "Connection lost before response (list_models)",
    ]);
  });

  it("断连错误经 onConnectionError 送达 store 的 lastError 通道（ISS-002「UI 能区分」链路）", async () => {
    const errs: string[] = [];
    const c = new HostClient({
      url: "ws://localhost:0",
      wsFactory: () => fakeWs,
      onEvent: () => {},
      onConnectionError: (m) => errs.push(m),
    });
    c.connect();
    fakeWs._open();
    void c.sendCommand({ type: "prompt", sessionId: "s1", message: "hi" }).catch(() => {});
    void c.sendCommand({ type: "abort", sessionId: "s1" }).catch(() => {});
    fakeWs._close();
    await Promise.resolve();
    // 首条带命令类型，其余汇总为「状态未知」条数，不刷屏覆盖 lastError
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Connection lost before response (prompt)");
    expect(errs[0]).toContain("另有 1 条");
    c.close();
  });

  it("手动 close() 仍用 HostClient closed 文案（回归保护）", async () => {
    client.connect();
    fakeWs._open();
    const promise = client.sendCommand({ type: "abort", sessionId: "s1" });
    let msg = "";
    void promise.catch((e: Error) => { msg = e.message; });
    client.close();
    await Promise.resolve();
    expect(msg).toBe("HostClient closed");
  });
});

/**
 * ISS-20260910-006：重连退避纯函数 calculateBackoffDelay 测试。
 * 纯数学函数直接验证数值区间、随机分布与上限饱和，无需拦截全局 setTimeout。
 */
describe("calculateBackoffDelay（ISS-006）", () => {
  it("random=0 → delay 恰为退避值的一半（jitter 只向下，不放大退避）", () => {
    expect(calculateBackoffDelay(1000, 15000, 0, () => 0)).toBe(500);
    expect(calculateBackoffDelay(1000, 15000, 1, () => 0)).toBe(1000);
    expect(calculateBackoffDelay(1000, 15000, 2, () => 0)).toBe(2000);
  });

  it("random=1 → delay 等于退避上限，且恒 ≤ maxMs", () => {
    expect(calculateBackoffDelay(1000, 15000, 0, () => 1)).toBe(1000);
    expect(calculateBackoffDelay(1000, 15000, 1, () => 1)).toBe(2000);
    expect(calculateBackoffDelay(1000, 15000, 10, () => 1)).toBe(15000);
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(calculateBackoffDelay(1000, 15000, attempt, () => 1)).toBeLessThanOrEqual(15000);
    }
  });

  it("不同 random 产生不同 delay（设备间去同步）", () => {
    const a = calculateBackoffDelay(1000, 15000, 0, () => 0.2);
    const b = calculateBackoffDelay(1000, 15000, 0, () => 0.8);
    expect(a).toBe(600);
    expect(b).toBe(900);
    expect(a).not.toBe(b);
  });

  it("默认 random 使用 Math.random，结果落在 [0.5 * backoff, backoff] 闭区间内", () => {
    const delay = calculateBackoffDelay(1000, 15000, 0);
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1000);
  });
});

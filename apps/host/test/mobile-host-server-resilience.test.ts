import { describe, expect, it, afterEach, vi } from "vitest";
import { MobileHostServer, clampCommandInt, sanitizeWsErrorMessage } from "../src/server/mobile-host-server.js";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

/**
 * WS 故障隔离与出站背压回归（odyssey-improve run-cea14fb1822d）。
 * 反向验证约定：回滚修复后本文件必须以「worker 崩溃 / 断言失败」暴露问题，
 * 不允许出现「回滚了还全绿」的空测试。
 */

function stubRuntimeFactory() {
  return {
    createRuntime: async () => { throw new Error("Not implemented in test"); },
    listSessions: async () => [],
  };
}

async function createServer(options: ConstructorParameters<typeof MobileHostServer>[1] = {}) {
  const tmpDir = join(tmpdir(), `maestro-ws-resil-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  const controller = new HostController(stubRuntimeFactory(), new MaestroStateReader({ projectRoot: tmpDir }));
  const server = new MobileHostServer(controller, options);
  await server.listen(0, "127.0.0.1");
  return { tmpDir, controller, server, port: server.address().port };
}

/**
 * 连接 + 首帧等待必须原子完成：服务端把 101 响应与 host_status 放在同一批 TCP 数据里时，
 * ws 客户端会在同一个 socket data 事件内连续 emit('open')→emit('message')。若 await open 之后
 * 才挂 message 监听，首帧会静默丢失（本文件初版即栽在此处，12 用例全部超时）。
 */
function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: Record<string, unknown>[] = [];
  const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  let error: Error | undefined;
  const deliver = (msg: Record<string, unknown>) => {
    // 必须按 type 路由：服务端连接时会连发 host_status/host_info 等多帧，
    // 先进先出的 waiters.shift() 会把 host_info 误交给正在等 command_result 的用例。
    const at = waiters.findIndex((w) => w.type === msg.type);
    if (at >= 0) waiters.splice(at, 1)[0].resolve(msg);
    else messages.push(msg);
  };
  ws.on("message", (data: WebSocket.RawData) => {
    deliver(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  ws.on("error", (e: Error) => { error = e; });
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const nextType = (type: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const buffered = messages.findIndex((m) => m.type === type);
      if (buffered >= 0) { resolve(messages.splice(buffered, 1)[0]); return; }
      if (error) { reject(error); return; }
      waiters.push({ type, resolve });
    });
  return { ws, opened, nextType };
}

/** 服务端 ClientSocket 的发送面替身；事件监听仍留在真实 socket 上 */
interface FakeSocket {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  sent: string[];
  closeCalls: { code?: number; reason?: string }[];
  terminated: boolean;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, cb: unknown): void;
  off(event: string, cb: unknown): void;
  ping(): void;
  _socket?: unknown;
}

interface Stubbed {
  fake: FakeSocket;
  client: { closing: boolean; droppedFrames: number; slowSince: number; [k: string]: unknown };
  restore: () => Promise<void>;
}

/**
 * 关键约束：restore 前不得关闭真实 socket——服务端 close 监听会把 client.closing 置真，
 * 背压用例会因「已关闭短路」这一错误原因假通过。
 */
async function stubClientSocket(ctx: Awaited<ReturnType<typeof createServer>>): Promise<Stubbed> {
  const conn = connect(ctx.port);
  await conn.opened;
  await conn.nextType("host_status");
  const clients = (ctx.server as unknown as { clients: Set<Stubbed["client"] & { ws: WebSocket }> }).clients;
  const client = [...clients][0] as Stubbed["client"] & { ws: WebSocket };
  const realWs = client.ws;
  const fake: FakeSocket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [],
    closeCalls: [],
    terminated: false,
    send(data: string) { this.sent.push(data); },
    close(code?: number, reason?: string) { this.closeCalls.push({ code, reason }); },
    terminate() { this.terminated = true; },
    on() { /* 替身不承接事件 */ },
    off() {},
    ping() {},
    _socket: undefined,
  };
  client.ws = fake as unknown as WebSocket;
  return {
    fake,
    client,
    restore: async () => {
      client.ws = realWs;
      // 恢复真实 socket 再关，否则 server.close() 只关替身、真实 socket 泄漏 → vitest 挂起
      if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) conn.ws.close();
    },
  };
}

/** 直接驱动服务端注册的广播 listener（走真实广播代码路径，不复制逻辑） */
function emitBroadcast(ctx: Awaited<ReturnType<typeof createServer>>, event: unknown): void {
  const listeners = (ctx.controller as unknown as { listeners: Set<(e: unknown) => void> }).listeners;
  for (const listener of listeners) listener(event);
}

const sessionUpdated = (seq: number) => ({ type: "session_updated", sessionId: "s", session: { id: "s" }, seq });

let ctx: Awaited<ReturnType<typeof createServer>> | undefined;

afterEach(async () => {
  await ctx?.server.close();
  await ctx?.controller.dispose();
  if (ctx) await rm(ctx.tmpDir, { recursive: true, force: true });
  ctx = undefined;
});

describe("WS inbound error isolation", () => {
  it("超限帧只断开该连接（1009），进程存活且后续连接仍可握手", async () => {
    ctx = await createServer({ maxPayload: 1024 });
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");

    const closed = new Promise<number>((resolve) => conn.ws.on("close", (code: number) => resolve(code)));
    conn.ws.send(Buffer.alloc(2048));

    // 能执行到这里 = worker 没被 uncaughtException RangeError 带走（修复前必崩）
    expect(await closed).toBe(1009); // ws 协议超限码，且不被 terminate 抢掉

    const conn2 = connect(ctx.port);
    await conn2.opened;
    const msg = await conn2.nextType("host_status");
    expect(msg.status).toBe("connected");
    conn2.ws.close();
  }, 10_000);

  it("协议级非法帧（RSV1/未掩码/非法 UTF-8）逐一隔离在连接粒度，进程存活", async () => {
    // 必须绕过 ws 客户端直接写 socket：ws.send(buffer) 会重新分帧，构造不出协议错误
    // （初版用例栽在此处——RSV1 校验根本没发生，连接被静默保持）。
    // 期望码取自 ws@8.21.3 receiver 实测：RSV1→1002、未掩码→1002、非法 UTF-8→1007。
    const cases: { name: string; frame: number[]; code: number }[] = [
      { name: "RSV1 set", frame: [0xc1, 0x80, 1, 2, 3, 4], code: 1002 },
      { name: "unmasked client frame", frame: [0x81, 0x00], code: 1002 },
      { name: "invalid utf-8 text", frame: [0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe], code: 1007 },
    ];
    for (const testCase of cases) {
      const ctx = await createServer({ maxPayload: 4096 });
      try {
        const conn = connect(ctx.port);
        await conn.opened;
        await conn.nextType("host_status");
        const closed = new Promise<number>((resolve) => conn.ws.on("close", (c: number) => resolve(c)));
        (conn.ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(Buffer.from(testCase.frame));
        // 能收到 close = 未被 terminate 抢掉通知帧，且 worker 未被 uncaughtException 带走
        expect(await closed, testCase.name).toBe(testCase.code);
        conn.ws.terminate();
      } finally {
        await ctx.server.close();
        await ctx.controller.dispose();
        await rm(ctx.tmpDir, { recursive: true, force: true });
      }
    }
    // 三种协议错误后 host 仍能服务新连接
    ctx = await createServer({ maxPayload: 4096 });
    const survivor = connect(ctx.port);
    await survivor.opened;
    expect((await survivor.nextType("host_status")).status).toBe("connected");
    survivor.ws.close();
  }, 20_000);
});

describe("WS outbound backpressure", () => {
  // 软阈 100KB / 硬顶 200KB；宽限设极大，使「硬顶优先」成为唯一断线路径，用例保持确定性
  const BP = { highWaterMarkBytes: 100_000, hardLimitBytes: 200_000, slowGraceMs: 600_000, heartbeatIntervalMs: 10_000 };

  it("RV-001：队列积压 + 新帧越过硬顶 → 断线（旧实现只看发送前 buffered，会放行使队列破顶）", async () => {
    ctx = await createServer(BP);
    const { fake, restore } = await stubClientSocket(ctx);
    // buffered=190KB < 硬顶 200KB，但加上 ~60KB 帧后越顶：旧实现此时判定"未超限"直接 send
    fake.bufferedAmount = 190_000;
    const big = { type: "session_updated", sessionId: "s", session: { id: "s", pad: "x".repeat(60_000) }, seq: 11 };
    emitBroadcast(ctx, big);
    expect(fake.sent.length).toBe(0);
    expect(fake.closeCalls[0]?.code).toBe(1013);
    await restore();
  }, 10_000);

  it("单帧自身超硬顶：照发不断线（防合法大 snapshot 触发重连死循环）", async () => {
    // 实测：4000 条 timeline 的 snapshot ≈ 7.4MB，逼近默认硬顶。若把超限单帧断掉，
    // 客户端重连后会拉到同一帧 → 无限循环。语义是"队列驻留有界"，不是"单帧有界"。
    ctx = await createServer(BP);
    const { fake, restore } = await stubClientSocket(ctx);
    fake.bufferedAmount = 0;
    const huge = { type: "session_updated", sessionId: "s", session: { id: "s", pad: "y".repeat(300_000) }, seq: 12 };
    emitBroadcast(ctx, huge);
    expect(fake.sent.length).toBe(1); // 唯一副本：宁发不丢
    expect(fake.closeCalls.length).toBe(0);
    await restore();
  }, 10_000);

  it("软阈以上：best_effort 丢弃、required 不静默丢、不断线", async () => {
    ctx = await createServer(BP);
    const { fake, restore } = await stubClientSocket(ctx);
    fake.bufferedAmount = 150_000;

    emitBroadcast(ctx, { type: "timeline_delta", sessionId: "s", itemId: "i", delta: "x", seq: 3 });
    expect(fake.sent.length).toBe(0); // 流式增量可丢：终态由 timeline_item 补齐

    emitBroadcast(ctx, sessionUpdated(4));
    expect(fake.sent.length).toBe(1); // 非 delta 事件一律 required
    expect(JSON.parse(fake.sent[0]).type).toBe("session_updated");
    expect(fake.closeCalls.length).toBe(0);
    await restore();
  }, 10_000);

  it("硬顶以上：required 立即 close(1013)，不等宽限期", async () => {
    ctx = await createServer(BP);
    const { fake, restore } = await stubClientSocket(ctx);
    fake.bufferedAmount = 250_000;

    emitBroadcast(ctx, sessionUpdated(5));
    expect(fake.sent.length).toBe(0);
    expect(fake.closeCalls[0]?.code).toBe(1013); // retryable，与满载拒绝同码 → 重连 + snapshot 补拉
    await restore();
  }, 10_000);

  it("宽限期内 required 继续投递（宁缓冲不丢），缓冲退去后 slowSince 清零", async () => {
    ctx = await createServer({ highWaterMarkBytes: 100_000, hardLimitBytes: 10_000_000, slowGraceMs: 600_000, heartbeatIntervalMs: 10_000 });
    const { fake, client, restore } = await stubClientSocket(ctx);
    fake.bufferedAmount = 150_000;

    emitBroadcast(ctx, sessionUpdated(6));
    expect(fake.sent.length).toBe(1);
    expect(fake.closeCalls.length).toBe(0);
    expect(client.slowSince).toBeGreaterThan(0);

    fake.bufferedAmount = 0;
    emitBroadcast(ctx, sessionUpdated(7));
    expect(fake.sent.length).toBe(2);
    expect(client.slowSince).toBe(0);
    await restore();
  }, 10_000);

  it("持续越阈超过宽限期 → close(1013)，且不得向已关连接再写一帧", async () => {
    ctx = await createServer({ highWaterMarkBytes: 100_000, hardLimitBytes: 10_000_000, slowGraceMs: 0, heartbeatIntervalMs: 10_000 });
    const { fake, restore } = await stubClientSocket(ctx);
    fake.bufferedAmount = 150_000;

    // grace 判定在「后续帧」：首帧记录 slowSince，宽限期到期后的下一帧才关（单帧内不可能既计时又超时）
    emitBroadcast(ctx, sessionUpdated(8));
    expect(fake.closeCalls.length).toBe(0);
    emitBroadcast(ctx, sessionUpdated(9));
    expect(fake.closeCalls[0]?.code).toBe(1013);
    // RV-001：旧实现在 closeClient() 后缺 return，会落到 rawSend 向 CLOSING socket 再写一帧。
    // 真实 ws 探针实测：该 send 不抛错、callback 会回调、bufferedAmount +14，但因连接已关而永不到达
    // ——即「已判定必须送达」的帧静默丢失。新实现必须由 closing 守卫短接，sent 保持 1。
    expect(fake.sent.length, "close 后不得再写（旧代码此处为 2）").toBe(1);
    await restore();
  }, 10_000);

  it("closing 后 sendFrame 短路：断连竞态不向死 socket 写出", async () => {
    ctx = await createServer(BP);
    const { fake, client, restore } = await stubClientSocket(ctx);
    client.closing = true;
    emitBroadcast(ctx, sessionUpdated(9));
    expect(fake.sent.length).toBe(0);
    await restore();
  }, 10_000);

  it("广播事件序列化失败只记一次并 return，不抛出", async () => {
    ctx = await createServer(BP);
    const { restore } = await stubClientSocket(ctx);
    const circular: Record<string, unknown> = { type: "maestro_state", seq: 1 };
    circular.state = circular;
    expect(() => emitBroadcast(ctx, circular)).not.toThrow();
    await restore();
  }, 10_000);

  it("慢客户端被关后从 clients 移除：后续广播不再遍历该连接", async () => {
    ctx = await createServer(BP);
    const { fake, client, restore } = await stubClientSocket(ctx);
    fake.bufferedAmount = 250_000;
    emitBroadcast(ctx, sessionUpdated(10));
    const clients = (ctx.server as unknown as { clients: Set<unknown> }).clients;
    expect(clients.has(client)).toBe(false);
    expect(client.closing).toBe(true);
    await restore();
  }, 10_000);
});

describe("WS heartbeat", () => {
  it("应答 pong 的活连接不被心跳误杀（ws.setTimeout 方案会误杀无 message 流量的连接）", async () => {
    ctx = await createServer({ heartbeatIntervalMs: 60 });
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");
    await new Promise((r) => setTimeout(r, 400)); // ≥6 个心跳周期
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
  }, 10_000);
});

describe("listen 失败不得泄漏心跳 interval（RV-003）", () => {
  it("EADDRINUSE 路径：setInterval 一次都不被调用；成功路径：恰好一次且 close() 后置空", async () => {
    const first = await createServer();
    const spy = vi.spyOn(globalThis, "setInterval");
    const second = new MobileHostServer(first.controller, { heartbeatIntervalMs: 50 });
    let error: NodeJS.ErrnoException | undefined;
    try {
      await second.listen(first.port, "127.0.0.1");
    } catch (caught) {
      error = caught as NodeJS.ErrnoException;
    }
    expect(error?.code).toBe("EADDRINUSE");
    // 旧实现：startHeartbeat 在 listen() 之前同步执行 → 失败后留下无人 cleanup 的 interval
    expect(spy.mock.calls.length, "listen 失败不得启动心跳").toBe(0);
    spy.mockRestore();

    // 成功路径必须启动且只启动一次，close() 后句柄置空（否则幂等守卫阻止重启）
    const probe = new MobileHostServer(first.controller, { heartbeatIntervalMs: 50 });
    const okSpy = vi.spyOn(globalThis, "setInterval");
    await probe.listen(0, "127.0.0.1");
    expect(okSpy.mock.calls.length).toBe(1);
    okSpy.mockRestore();
    const asTimer = probe as unknown as { heartbeatTimer: unknown };
    expect(asTimer.heartbeatTimer, "listen 成功后心跳必须在跑").toBeDefined();
    await probe.close();
    expect(asTimer.heartbeatTimer, "close() 必须置空句柄").toBeUndefined();
    await first.server.close();
    await first.controller.dispose();
  }, 15_000);
});

describe("WS heartbeat miss tolerance", () => {
  // 钉住 HEARTBEAT_MAX_MISSES=2 的语义：单次 pong 漏答（event loop 卡顿即可造成）
  // 不得 terminate 健康连接；连续漏答达上限才断。修复前（!alive 即杀）本用例第一跳就挂。
  // 不依赖时间窗判定“还没被杀”（固定窗口会跨多个 tick，在高负载下必然竞态）：
  // 而是记录 terminate 发生时的状态——新实现需漏答 2 次才杀，旧实现（!alive 即杀）1 次就杀。
  it("漏答不立即杀连接：terminate 时已连续漏答达上限", async () => {
    ctx = await createServer({ heartbeatIntervalMs: 40 });
    const { fake, client, restore } = await stubClientSocket(ctx);
    fake.on = () => {}; // 替身不派发事件 → pong 永不到达，模拟对端无响应
    const asClient = client as unknown as { heartbeatMisses: number };
    let pings = 0;
    let killedAt: { misses: number; pings: number } | undefined;
    fake.ping = () => { pings++; };
    fake.terminate = () => {
      killedAt ??= { misses: asClient.heartbeatMisses, pings };
    };

    await vi.waitFor(() => expect(killedAt, "无响应的连接最终必须被回收").toBeDefined(), { timeout: 4000, interval: 20 });
    // 区分点：MAX_MISSES=2 下，服务端在杀掉前已发出 2 次 ping（即容忍了一次漏答）；
    // 旧语义（单次漏答即 terminate）只来得及 1 次 ping，misses 为 1。
    expect(killedAt!.pings, "至少要给健康连接一次重答机会（旧实现在此只有 1）").toBeGreaterThanOrEqual(2);
    expect(killedAt!.misses).toBeGreaterThanOrEqual(2);
    await restore();
  }, 15_000);

  it("收到 message 数据时重置 heartbeatMisses（防止仅依赖 pong 误杀活动客户端）", async () => {
    ctx = await createServer({ heartbeatIntervalMs: 40 });
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");

    const clients = (ctx.server as unknown as { clients: Set<{ heartbeatMisses: number }> }).clients;
    const client = [...clients][0];
    client.heartbeatMisses = 2; // 模拟已累积 2 次未应答 pong

    // 客户端发送任意一条有效指令或帧
    conn.ws.send(JSON.stringify({ type: "list_live_sessions" }));
    await new Promise((r) => setTimeout(r, 50));

    // 收到 message 后，heartbeatMisses 必须被立即重置为 0
    expect(client.heartbeatMisses).toBe(0);
    conn.ws.close();
  });
});

describe("search_history 参数钳制", () => {
  it("越界 maxResults 走 session_not_found 且不抛；钳制算式落在 [1, 上限]", async () => {
    ctx = await createServer();
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");

    const reply = conn.nextType("command_result");
    conn.ws.send(JSON.stringify({ id: "q1", type: "search_history", sessionId: "missing", keyword: "x", maxResults: 1e9, previewLength: 1e9 }));
    const msg = await reply;
    expect((msg.error as { code: string }).code).toBe("session_not_found");
    conn.ws.close();

    // 直接钉生产函数本体（测试复制算式会假通过）
    expect(clampCommandInt(1e9, 50, 200)).toBe(200);
    expect(clampCommandInt(-5, 50, 200)).toBe(1);
    expect(clampCommandInt(0, 50, 200)).toBe(1);
    expect(clampCommandInt(NaN, 50, 200)).toBe(50);
    expect(clampCommandInt(Infinity, 50, 200)).toBe(50);
    expect(clampCommandInt(undefined, 50, 200)).toBe(50);
    expect(clampCommandInt(7.9, 50, 200)).toBe(7);
  }, 10_000);
});

describe("command_result 关联 id（in_reply_to）", () => {
  // 客户端 host-client.ts:263 用 in_reply_to 匹配 pendingCommands；空值会让命令挂满 30s 超时。
  // 修复前实测：sendError 的 16 处调用把 command id 传进了 message 位，in_reply_to 恒为 ""。
  const errorCases = [
    { name: "session_not_found", cmd: { id: "ID-SEARCH", type: "search_history", sessionId: "missing", keyword: "x" } },
    { name: "unsupported_command", cmd: { id: "ID-UNS", type: "unsupported_xyz" } },
    { name: "invalid_command(缺 type)", cmd: { id: "ID-INVALID", cwd: "/tmp" } },
    { name: "command_failed(处理中抛错)", cmd: { id: "ID-FAIL", type: "open_session", cwd: "/nope" } },
  ];
  for (const c of errorCases) {
    it(`${c.name} 的错误响应必须回显 in_reply_to=${c.cmd.id}`, async () => {
      ctx = await createServer();
      const conn = connect(ctx.port);
      await conn.opened;
      await conn.nextType("host_status");
      const reply = conn.nextType("command_result");
      conn.ws.send(JSON.stringify(c.cmd));
      const msg = await reply;
      expect(msg.in_reply_to, c.name).toBe(c.cmd.id);
      expect(msg.ok).toBe(false);
      // message 位不得被塞成 command id（修复前的形态）
      const err = msg.error as { message?: string };
      expect(err?.message, "message 位不应是 command id").not.toBe(c.cmd.id);
      conn.ws.close();
    }, 10_000);
  }

  it("ISS-003：数值 id 被校验拒绝，且仍立即回 command_result（不挂 30s）", async () => {
    // 修复前：validateClientCommand 只检 type → 数值 id 被服务端原样回显进 in_reply_to，
    // 客户端 host-client.ts:263 把非字符串归一为 "" 后匹配不到 → 该命令挂满 30s 超时。
    // 修复后：shared 侧拒绝非 string id（validation.ts），服务端回 invalid_command。
    // 非字符串 id 无法被客户端匹配，因此 in_reply_to 必须是空串（不伪造可匹配 id）。
    ctx = await createServer();
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");
    const reply = conn.nextType("command_result");
    conn.ws.send(JSON.stringify({ id: 42, type: "abort", sessionId: "s1" }));
    const msg = await reply; // 超时即失败：本用例的判据就是「立即返回」
    expect((msg.error as { code?: string }).code).toBe("invalid_command");
    expect((msg.error as { message?: string }).message).toContain("id must be a string");
    expect(msg.in_reply_to).toBe("");
    expect(msg.ok).toBe(false);
    conn.ws.close();
  }, 10_000);

  it("非法 JSON 无法取 id：回裸 error 事件且不崩", async () => {
    ctx = await createServer();
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");
    const errEvent = conn.nextType("error");
    conn.ws.send("not-json{{{");
    const msg = await errEvent;
    expect((msg as { code?: string }).code).toBe("invalid_json");
    conn.ws.close();
  }, 10_000);
});

describe("错误响应脱敏", () => {
  it("RV-002：只抹已知敏感值，不误删 API 路径与 URL 等诊断信息", async () => {
    const home = require("node:os").homedir() as string;
    // 保留：普通 API 路径、URL、相对路径（旧实现用泛用正则会把它们折叠成最后一段）
    expect(sanitizeWsErrorMessage("request failed for /api/v1/users")).toContain("/api/v1/users");
    expect(sanitizeWsErrorMessage("see http://host:4739/api/v1 for status")).toContain("http://host:4739/api/v1");
    expect(sanitizeWsErrorMessage("ENOENT: no such file ./relative/config.json")).toContain("./relative/config.json");
    // 抹除：home 目录、显式密串、Windows 盘符
    expect(sanitizeWsErrorMessage(`open failed ${home}/.pi/secrets.json`)).not.toContain(home);
    expect(sanitizeWsErrorMessage("url ws://x/ws?token=abc123def456", ["abc123def456"])).not.toContain("abc123def456");
    expect(sanitizeWsErrorMessage("read C:\\Users\\bob\\project\\a.ts failed")).not.toMatch(/[A-Za-z]:\\Users/);
    // 限长与去换行
    expect(sanitizeWsErrorMessage("a\r\nb").length).toBeLessThanOrEqual(200);
    expect(sanitizeWsErrorMessage("line1\nline2")).toBe("line1 line2");
  });


  it("command_failed 不回传绝对路径", async () => {
    ctx = await createServer();
    const conn = connect(ctx.port);
    await conn.opened;
    await conn.nextType("host_status");

    const reply = conn.nextType("command_result");
    // open_session 走 stubRuntimeFactory 抛错 → 命中 command_failed 分支
    conn.ws.send(JSON.stringify({ id: "e1", type: "open_session", cwd: "/Users/secret-user/some-project" }));
    const msg = await reply;
    const message = String((msg.error as { message?: string }).message ?? "");
    expect(message).not.toMatch(/\/Users\/|\\\\Users\\\\/);
    conn.ws.close();
  }, 10_000);
});

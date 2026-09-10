import { describe, expect, it, beforeEach } from "vitest";
import {
  createInitialState,
  reduceEvent,
  createAppActions,
  type AppState,
} from "../src/app-state.js";
import { ExtensionUiQueue } from "../src/extension-ui-queue.js";
import type { HostEvent, SessionState, TimelineItem, MaestroState } from "@maestro-mobile/shared";

describe("AppState reducer", () => {
  it("H4: __event_batch folds events in order with single state transition", () => {
    let state = createInitialState();
    const mkTimeline = (id: string, text: string): TimelineItem => ({ id, kind: "assistant", text, createdAt: "" });
    const sessionId = "s1";
    const batch = {
      type: "__event_batch" as const,
      events: [
        { type: "session_updated", session: { id: sessionId, title: "t", status: "running" } as unknown as SessionState },
        { type: "timeline_item", sessionId, item: mkTimeline("a1", "hel") },
        { type: "timeline_delta", sessionId, itemId: "a1", delta: "lo world" },
        { type: "timeline_item", sessionId, item: mkTimeline("a2", "second") },
      ] as unknown as HostEvent[],
    };
    const before = state;
    state = reduceEvent(state, batch as never);
    // 单次状态更新（返回新对象，且结果与逐个 dispatch 相同）
    expect(state).not.toBe(before);
    const items = state.timelines.get(sessionId);
    expect(items?.length).toBe(2);
    expect(items?.[0].text).toBe("hello world"); // delta 折叠生效（顺序保持）
    expect(items?.[1].text).toBe("second");
  });

  it("creates initial state", () => {
    const state = createInitialState();
    expect(state.connectionStatus).toBe("disconnected");
    expect(state.sessions.size).toBe(0);
    expect(state.maestro).toBeNull();
    expect(state.dialogs).toEqual([]);
  });

  it("handles host_status event", () => {
    const state = reduceEvent(createInitialState(), {
      type: "host_status",
      status: "connected",
      seq: 1,
    });
    expect(state.connectionStatus).toBe("connected");
  });

  it("handles session_updated event", () => {
    const session: SessionState = {
      id: "s1", cwd: "/test", title: "Test", runState: "idle",
      messageCount: 0, pendingMessageCount: 0, updatedAt: "",
    };
    const state = reduceEvent(createInitialState(), {
      type: "session_updated", session, seq: 1,
    });
    expect(state.sessions.get("s1")?.title).toBe("Test");
  });

  it("handles timeline_item event", () => {
    const item: TimelineItem = {
      id: "t1", kind: "user", text: "hello", createdAt: "",
    };
    const state = reduceEvent(createInitialState(), {
      type: "timeline_item", sessionId: "s1", item, seq: 1,
    });
    expect(state.timelines.get("s1")).toHaveLength(1);
    expect(state.timelines.get("s1")![0].text).toBe("hello");
  });

  it("handles timeline_delta event", () => {
    const item: TimelineItem = {
      id: "t1", kind: "assistant", text: "Hel", createdAt: "",
    };
    let state = reduceEvent(createInitialState(), {
      type: "timeline_item", sessionId: "s1", item, seq: 1,
    });
    state = reduceEvent(state, {
      type: "timeline_delta", sessionId: "s1", itemId: "t1", delta: "lo", seq: 2,
    });
    expect(state.timelines.get("s1")![0].text).toBe("Hello");
  });

  it("handles maestro_state event", () => {
    const maestro: MaestroState = {
      schedules: [], observedAt: "",
    };
    const state = reduceEvent(createInitialState(), {
      type: "maestro_state", state: maestro, seq: 1,
    });
    expect(state.maestro).toBe(maestro);
  });

  it("handles extension_ui_request via queue", () => {
    const queue = new ExtensionUiQueue();
    const state = reduceEvent(createInitialState(), {
      type: "extension_ui_request",
      sessionId: "s1",
      request: { id: "r1", sessionId: "s1", method: "select", title: "Pick", options: ["A", "B"] },
      seq: 1,
    }, { dialogQueue: queue });
    expect(state.dialogs).toHaveLength(1);
    expect(state.dialogs[0].request.method).toBe("select");
  });

  it("handles extension_ui_cleared event", () => {
    const queue = new ExtensionUiQueue();
    queue.enqueue({ id: "r1", sessionId: "s1", method: "select", title: "Pick" });
    const state = reduceEvent(createInitialState(), {
      type: "extension_ui_cleared", sessionId: "s1", requestId: "r1", seq: 1,
    }, { dialogQueue: queue });
    expect(state.dialogs).toHaveLength(0);
  });

  it("handles error event", () => {
    const state = reduceEvent(createInitialState(), {
      type: "error", code: "E001", message: "Something failed", seq: 1,
    });
    expect(state.lastError).toBe("Something failed");
  });
});

describe("createAppActions", () => {
  it("prepends older history via __history_prepend with dedup", () => {
    const t1: TimelineItem = { id: "a", kind: "user", text: "旧消息", createdAt: "" };
    const t2: TimelineItem = { id: "b", kind: "assistant", text: "新消息", createdAt: "" };
    let state = reduceEvent(createInitialState(), { type: "__history_load", sessionId: "s1", items: [t2], seq: 1 });
    // 加载更早的一页（含重复的 b 应去重）
    state = reduceEvent(state, { type: "__history_prepend", sessionId: "s1", items: [t1, t2], seq: 2 });
    const items = state.timelines.get("s1")!;
    expect(items.map((i) => i.id)).toEqual(["a", "b"]); // t1 在最前, b 不重复
  });

  it("prepends to empty timeline", () => {
    const t1: TimelineItem = { id: "x", kind: "user", text: "唯一", createdAt: "" };
    const state = reduceEvent(createInitialState(), { type: "__history_prepend", sessionId: "s1", items: [t1], seq: 1 });
    expect(state.timelines.get("s1")!.map((i) => i.id)).toEqual(["x"]);
  });

  it("answerDialog sends response via queue and responder", () => {
    let responded = false;
    const queue = new ExtensionUiQueue();
    queue.enqueue({ id: "r1", sessionId: "s1", method: "input", title: "Name" });
    const actions = createAppActions(queue, (_sessionId, requestId, _response) => {
      expect(requestId).toBe("r1");
      responded = true;
    });
    actions.answerDialog("r1", "Alice");
    expect(responded).toBe(true);
    // 队列中已移除
    expect(queue.get("r1")?.status).toBe("answered");
  });

  it("cancelDialog sends cancel response", () => {
    let responded = false;
    const queue = new ExtensionUiQueue();
    queue.enqueue({ id: "r2", sessionId: "s1", method: "select", title: "Pick" });
    const actions = createAppActions(queue, (_sessionId, _requestId, response) => {
      const r = response as { cancelled?: boolean };
      expect(r.cancelled).toBe(true);
      responded = true;
    });
    actions.cancelDialog("r2");
    expect(responded).toBe(true);
  });
});

/**
 * ISS-20260910 review F-001 / F-002：断连时弹窗答案不得静默丢失，
 * 本地错误不得冒充 host 事件流帧。
 * 反向验证：删除 reducer 的 __dialog_send_failed / __local_error 分支后，前两条必挂。
 */
describe("__dialog_send_failed 与 __local_error（review F-001/F-002）", () => {
  const req = { id: "r9", sessionId: "s1", method: "select", title: "Pick", options: ["A"] };

  it("发送失败：弹窗重新入队且写 lastError（旧实现弹窗永不消失、无提示）", () => {
    const queue = new ExtensionUiQueue();
    queue.enqueue(req);
    let state = reduceEvent(createInitialState(), { type: "extension_ui_request", request: req, seq: 1 } as HostEvent, { dialogQueue: queue });
    expect(state.dialogs.map((d) => d.request.id)).toEqual(["r9"]);

    // 用户作答 ⇒ answer 把条目变终态；此时弹窗从 pending 视图消失
    let sent = 0;
    const actions = createAppActions(queue, (_s, _id, _r, request) => { sent++; void request; });
    actions.answerDialog("r9", "A");
    expect(sent).toBe(1);
    state = reduceEvent(state, { type: "__dialog_send_failed", request: req, message: "Connection lost before response (extension_ui_response)" } as never, { dialogQueue: queue });

    // 断连 ⇒ 响应永不到达：弹窗必须回来（答案未丢失），并提示错误
    expect(state.dialogs.map((d) => d.request.id), "弹窗须重新出现，否则用户以为已提交").toEqual(["r9"]);
    expect(state.dialogs[0].status).toBe("pending");
    expect(state.lastError).toContain("Connection lost");
  });

  it("S_CONFIRM 回归：发送失败不得使已过期的弹窗复活并重获完整超时", () => {
    // 上一版修复用 enqueue 重建条目 ⇒ receivedAt 被刷新（实测 revived:1,status:pending,ageMs:0）。
    // 现由 reopen 保留原 receivedAt；已过期 ⇒ 不恢复，只提示无需重试。
    let now = 1000;
    const queue = new ExtensionUiQueue({ defaultTimeoutMs: 1, now: () => now });
    queue.enqueue(req);
    createAppActions(queue, () => undefined).answerDialog("r9", "A");
    now = 5000; // 早已过期：host 侧已放弃这个 ask，复活它只会误导用户
    const state = reduceEvent(createInitialState(), { type: "__dialog_send_failed", request: req, message: "lost" } as never, { dialogQueue: queue });
    expect(state.dialogs, "过期弹窗不得复活").toHaveLength(0);
    expect(state.lastError).toContain("已超时或已清理");
  });

  it("S_CONFIRM：窗口内恢复保留原 receivedAt，并按原时限正常过期（不永不过期）", () => {
    let now = 1000;
    const queue = new ExtensionUiQueue({ defaultTimeoutMs: 10_000, now: () => now });
    queue.enqueue(req);
    createAppActions(queue, () => undefined).answerDialog("r9", "A");
    now = 6000;
    const state = reduceEvent(createInitialState(), { type: "__dialog_send_failed", request: req, message: "lost" } as never, { dialogQueue: queue });
    expect(state.dialogs.map((d) => d.status)).toEqual(["pending"]);
    expect(queue.get("r9")?.receivedAt, "receivedAt 必须保留原值（enqueue 会刷新）").toBe(1000);
    expect(state.lastError).toBe("lost");
    now = 11_001; // 越过原时限 (1000 + 10_000) ⇒ 正常过期
    expect(queue.pendingDialogs).toHaveLength(0);
  });

  it("__local_error 写 lastError 但不产生 host 帧（域分离，无 seq 占位）", () => {
    let state = reduceEvent(createInitialState(), { type: "__local_error", message: "boom" } as never);
    expect(state.lastError).toBe("boom");
    // 不得污染任何 host 事件流可观察状态
    expect(state.dialogs).toEqual([]);
    expect(state.timelines.size).toBe(0);
  });

  it("answerDialog 把原 request 交给 responder；已 answered 时 cancelDialog 早退不重复发送", () => {
    const queue = new ExtensionUiQueue();
    queue.enqueue(req);
    const seen: string[] = [];
    const actions = createAppActions(queue, (_s, _id, _r, request) => seen.push(request.id));
    actions.answerDialog("r9", "A");
    actions.cancelDialog("r9"); // 已 answered ⇒ cancelDialog 早退，不重复发送
    expect(seen).toEqual(["r9"]);
  });
});

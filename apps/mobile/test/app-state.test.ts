import { describe, expect, it, beforeEach } from "vitest";
import {
  createInitialState,
  reduceEvent,
  createAppActions,
  MAX_SESSION_SUMMARY_PATCHES,
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

  it("bounds retained exact-target summary patches", () => {
    let state = createInitialState();
    for (let index = 0; index < MAX_SESSION_SUMMARY_PATCHES + 4; index += 1) {
      const target = { sessionId: `s-${index}`, endpointId: "desktop", normalizedCwd: "/work", processGeneration: `g-${index}` };
      state = reduceEvent(state, {
        type: "session_summary_updated",
        target,
        patch: { runtimeStatus: "idle" },
        revision: index + 1,
        seq: index + 1,
      });
    }
    expect(state.sessionSummaryPatches.size).toBe(MAX_SESSION_SUMMARY_PATCHES);
  });

  it("starts a fresh summary patch epoch on reset", () => {
    const target = { sessionId: "reset-session", endpointId: "desktop", normalizedCwd: "/work", processGeneration: "g1" };
    let state = reduceEvent(createInitialState(), {
      type: "session_summary_updated",
      target,
      patch: {
        runtimeStatus: "running",
        messageCount: 9,
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: 0.2 },
        context: { tokens: 18, contextWindow: 100, percent: 18 },
      },
      revision: 1,
      seq: 1,
    });
    state = reduceEvent(state, {
      type: "session_summary_updated",
      target,
      patch: { reset: true, runtimeStatus: "sleeping", activeSince: null },
      revision: 2,
      seq: 2,
    });

    expect(state.sessionSummaryPatches.get(JSON.stringify(["reset-session", "desktop", "/work", "g1"]))?.patch).toEqual({
      reset: true,
      runtimeStatus: "sleeping",
      activeSince: null,
    });
  });

  it("projects exact-target runtime summaries into the active session detail", () => {
    const target = { sessionId: "summary-session", endpointId: "desktop", normalizedCwd: "/work", processGeneration: "g1" };
    const base: SessionState = {
      id: target.sessionId, cwd: target.normalizedCwd, title: "Summary", runState: "idle",
      messageCount: 1, pendingMessageCount: 0, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let state = reduceEvent(createInitialState(), { type: "__snapshot_load", session: base, items: [], seq: 0, target });
    state = reduceEvent(state, {
      type: "session_summary_updated",
      target,
      patch: { runtimeStatus: "running", messageCount: 2, lastActivityAt: "2026-01-01T00:00:01.000Z" },
      revision: 1,
      seq: 1,
    });
    const key = JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration]);
    expect(state.targetedSessions.get(key)).toMatchObject({ runState: "streaming", messageCount: 2, updatedAt: "2026-01-01T00:00:01.000Z" });

    state = reduceEvent(state, {
      type: "session_summary_updated",
      target,
      patch: { runtimeStatus: "idle" },
      revision: 2,
      seq: 2,
    });
    expect(state.targetedSessions.get(key)?.runState).toBe("idle");

    state = reduceEvent(state, {
      type: "session_summary_updated",
      target,
      patch: { reset: true, runtimeStatus: "idle" },
      revision: 3,
      seq: 3,
    });
    expect(state.targetedSessions.get(key)).toMatchObject({ runState: "idle", messageCount: 2 });
  });

  it("does not clone a sibling session when an unloaded exact target emits a summary", () => {
    const loaded = { sessionId: "summary-sibling", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "g1" };
    const sibling = { ...loaded, endpointId: "desktop-2", processGeneration: "g2" };
    const base: SessionState = {
      id: loaded.sessionId, cwd: loaded.normalizedCwd, title: "Loaded", runState: "idle",
      messageCount: 4, pendingMessageCount: 0, updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let state = reduceEvent(createInitialState(), { type: "__snapshot_load", session: base, items: [], seq: 0, target: loaded });
    state = reduceEvent(state, {
      type: "session_summary_updated",
      target: sibling,
      patch: { runtimeStatus: "running", messageCount: 9 },
      revision: 1,
      seq: 1,
    });
    expect(state.targetedSessions.has(JSON.stringify([sibling.sessionId, sibling.endpointId, sibling.normalizedCwd, sibling.processGeneration]))).toBe(false);
    expect(state.sessions.get(loaded.sessionId)?.messageCount).toBe(4);
  });

  it("keeps targeted timelines and event sequences separate for sibling endpoints", () => {
    const first = { sessionId: "same", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "g1" };
    const second = { ...first, endpointId: "desktop-2", processGeneration: "g2" };
    let state = createInitialState();
    state = reduceEvent(state, { type: "timeline_item", sessionId: "same", target: first, item: { id: "item", kind: "assistant", text: "first", createdAt: "" }, seq: 2 });
    state = reduceEvent(state, { type: "timeline_item", sessionId: "same", target: second, item: { id: "item", kind: "assistant", text: "second", createdAt: "" }, seq: 1 });
    state = reduceEvent(state, { type: "timeline_delta", sessionId: "same", target: first, itemId: "item", delta: " stale", seq: 1 });
    expect([...state.targetedTimelines.values()].map((items) => items[0]?.text).sort()).toEqual(["first", "second"]);
  });

  it("replaces only the exact target timeline after a readerless replay", () => {
    const first = { sessionId: "replay", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "g1" };
    const second = { ...first, endpointId: "desktop-2", processGeneration: "g2" };
    let state = reduceEvent(createInitialState(), {
      type: "timeline_item", sessionId: first.sessionId, target: first,
      item: { id: "old", kind: "assistant", text: "old", createdAt: "" }, seq: 1,
    });
    state = reduceEvent(state, {
      type: "timeline_item", sessionId: second.sessionId, target: second,
      item: { id: "sibling", kind: "assistant", text: "sibling", createdAt: "" }, seq: 1,
    });
    state = reduceEvent(state, {
      type: "timeline_snapshot", sessionId: first.sessionId, target: first,
      items: [{ id: "new", kind: "assistant", text: "new", createdAt: "" }], seq: 2,
    });
    expect(state.targetedTimelines.get(JSON.stringify([first.sessionId, first.endpointId, first.normalizedCwd, first.processGeneration]))?.map((item) => item.text)).toEqual(["new"]);
    expect(state.targetedTimelines.get(JSON.stringify([second.sessionId, second.endpointId, second.normalizedCwd, second.processGeneration]))?.map((item) => item.text)).toEqual(["sibling"]);
  });

  it("rejects readonly snapshots after a newer target event", () => {
    const target = { sessionId: "same", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "g1" };
    const base: SessionState = { id: "same", cwd: "/work", title: "base", runState: "idle", messageCount: 0, pendingMessageCount: 0, updatedAt: "" };
    let state = reduceEvent(createInitialState(), { type: "session_updated", session: { ...base, title: "new" }, target, seq: 3 });
    state = reduceEvent(state, { type: "__snapshot_load", session: { ...base, title: "old" }, items: [], seq: 0, target });
    expect(state.targetedSessions.get(JSON.stringify(["same", "desktop-1", "/work", "g1"]))?.title).toBe("new");
  });

  it("keeps targeted session updates separate for sibling endpoints", () => {
    const first = { sessionId: "same", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "g1" };
    const second = { ...first, endpointId: "desktop-2", processGeneration: "g2" };
    const base: SessionState = { id: "same", cwd: "/work", title: "first", runState: "idle", messageCount: 0, pendingMessageCount: 0, updatedAt: "" };
    let state = reduceEvent(createInitialState(), { type: "__snapshot_load", session: base, items: [], seq: 0, target: first });
    state = reduceEvent(state, { type: "session_updated", session: { ...base, title: "second" }, target: second, seq: 1 });
    expect(state.sessions.get("same")?.title).toBe("first");
    expect(state.targetedSessions.get(JSON.stringify(["same", "desktop-2", "/work", "g2"]))?.title).toBe("second");
  });

  it("uses the latest server thinkingLevel for local and reconnect snapshots", () => {
    const base: SessionState = {
      id: "thinking-session", cwd: "/work", title: "Thinking", runState: "idle",
      messageCount: 0, pendingMessageCount: 0, updatedAt: "2026-01-01T00:00:00.000Z", thinkingLevel: "low",
    };
    let state = reduceEvent(createInitialState(), { type: "session_updated", session: base, seq: 1 });
    expect(state.sessions.get(base.id)?.thinkingLevel).toBe("low");

    state = reduceEvent(state, {
      type: "session_updated",
      session: { ...base, thinkingLevel: "high", updatedAt: "2026-01-01T00:00:01.000Z" },
      seq: 2,
    });
    expect(state.sessions.get(base.id)?.thinkingLevel).toBe("high");

    state = reduceEvent(state, {
      type: "session_updated",
      session: { ...base, thinkingLevel: "minimal", updatedAt: "2026-01-01T00:00:02.000Z" },
      seq: 3,
    });
    expect(state.sessions.get(base.id)?.thinkingLevel).toBe("minimal");
  });

  it("patches exact-target summary events without merging sibling endpoints", () => {
    const first = { sessionId: "same", endpointId: "desktop-1", normalizedCwd: "/work/app", processGeneration: "g1" };
    const second = { ...first, endpointId: "desktop-2", processGeneration: "g2" };
    let state = reduceEvent(createInitialState(), {
      type: "session_summary_updated", target: first,
      patch: { runtimeStatus: "running", activeSince: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:01.000Z", messageCount: 2 },
      revision: 4, seq: 1,
    });
    state = reduceEvent(state, {
      type: "session_summary_updated", target: second,
      patch: { runtimeStatus: "idle", lastActivityAt: "2026-01-01T00:00:02.000Z" },
      revision: 5, seq: 2,
    });
    expect(state.sessionSummaryPatches.size).toBe(2);
    expect([...state.sessionSummaryPatches.values()][0].patch.runtimeStatus).toBe("running");
    expect([...state.sessionSummaryPatches.values()][1].patch.runtimeStatus).toBe("idle");
    expect(state.revision).toBe(5);
    state = reduceEvent(state, {
      type: "session_summary_updated", target: first,
      patch: { messageCount: 3 }, revision: 6, seq: 3,
    });
    expect(state.sessionSummaryPatches.get(JSON.stringify(["same", "desktop-1", "/work/app", "g1"]))?.patch).toMatchObject({ runtimeStatus: "running", messageCount: 3 });
    state = reduceEvent(state, {
      type: "session_summary_updated", target: first,
      patch: { runtimeStatus: "idle" }, revision: 3, seq: 4,
    });
    expect(state.sessionSummaryPatches.get(JSON.stringify(["same", "desktop-1", "/work/app", "g1"]))?.patch.runtimeStatus).toBe("running");
  });

  it("orders snapshots only within their runner-local namespace", () => {
    const target = { sessionId: "snapshot-session", endpointId: "host-1", normalizedCwd: "/work", processGeneration: "g1" };
    const unrelated = { sessionId: "other", endpointId: "host-2", normalizedCwd: "/other", processGeneration: "g2" };
    const base = { id: "snapshot-session", cwd: "/work", title: "old", runState: "idle" as const, messageCount: 0, pendingMessageCount: 0, updatedAt: "", thinkingLevel: "low" };

    let state = reduceEvent(createInitialState(), {
      type: "session_updated",
      session: { ...base, id: "other", title: "unrelated" },
      target: unrelated,
      seq: 90,
    });
    state = reduceEvent(state, { type: "__snapshot_load", session: base, items: [], seq: 2, wireSeq: 91, target });
    expect(state.targetedSessions.get(JSON.stringify(["snapshot-session", "host-1", "/work", "g1"]))?.title).toBe("old");
    expect(state.snapshotNextSeq.get(`target:${JSON.stringify(["snapshot-session", "host-1", "/work", "g1"])}`)).toBe(2);

    state = reduceEvent(state, { type: "__snapshot_load", session: { ...base, title: "latest" }, items: [], seq: 3, wireSeq: 91, target });
    state = reduceEvent(state, { type: "__snapshot_load", session: { ...base, title: "stale" }, items: [], seq: 2, wireSeq: 91, target });
    expect(state.targetedSessions.get(JSON.stringify(["snapshot-session", "host-1", "/work", "g1"]))?.title).toBe("latest");

    state = reduceEvent(state, { type: "__snapshot_load", session: { ...base, title: "presentation-newer" }, items: [], seq: 3, wireSeq: 92, target });
    expect(state.targetedSessions.get(JSON.stringify(["snapshot-session", "host-1", "/work", "g1"]))?.title).toBe("presentation-newer");

    state = reduceEvent(state, { type: "session_updated", session: { ...base, title: "wire-newer" }, target, seq: 92 });
    state = reduceEvent(state, { type: "__snapshot_load", session: { ...base, title: "wire-stale" }, items: [], seq: 4, wireSeq: 92, target });
    expect(state.targetedSessions.get(JSON.stringify(["snapshot-session", "host-1", "/work", "g1"]))?.title).toBe("wire-newer");
    expect(state.targetEventSeq.get(JSON.stringify(["other", "host-2", "/other", "g2"]))).toBe(90);
  });

  it("does not advance the global wire watermark from a runner-local snapshot", () => {
    const session = { id: "snapshot-session", cwd: "/work", title: "snapshot", runState: "idle" as const, messageCount: 0, pendingMessageCount: 0, updatedAt: "" };
    let state = reduceEvent(createInitialState(), { type: "host_status", status: "connected", seq: 7 });
    state = reduceEvent(state, { type: "__snapshot_load", session, items: [], seq: 100, wireSeq: 8 });
    expect(state.sessions.get(session.id)?.title).toBe("snapshot");
    expect(state.eventSeq).toBe(7);
    expect(state.snapshotNextSeq.get(`session:${session.id}`)).toBe(100);
  });

  it("keeps app revision monotonic and rejects stale server presentation updates", () => {
    const presentation = (revision: number) => ({
      role: "session" as const, visibility: "session_list" as const,
      control: { mode: "readonly" as const, canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision,
    });
    let state = reduceEvent(createInitialState(), { type: "__revision", revision: 5 });
    expect(reduceEvent(state, { type: "__revision", revision: 3 }).revision).toBe(5);
    state = reduceEvent(state, { type: "session_updated", seq: 1, session: {
      id: "s1", cwd: "/test", title: "new", runState: "idle", messageCount: 0, pendingMessageCount: 0, updatedAt: "", presentation: presentation(5),
    } });
    state = reduceEvent(state, { type: "session_updated", seq: 2, session: {
      id: "s1", cwd: "/test", title: "stale", runState: "idle", messageCount: 0, pendingMessageCount: 0, updatedAt: "", presentation: presentation(4),
    } });
    expect(state.sessions.get("s1")?.title).toBe("new");
    expect(state.revision).toBe(5);
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

  it("answerDialog notifies the reducer to refresh the optimistic queue projection", () => {
    const queue = new ExtensionUiQueue();
    const request = { id: "r3", sessionId: "s1", method: "input" as const, title: "Name" };
    queue.enqueue(request);
    let state = reduceEvent(createInitialState(), { type: "extension_ui_request", request, seq: 1 } as HostEvent, { dialogQueue: queue });
    const actions = createAppActions(queue, () => undefined, () => {
      state = reduceEvent(state, { type: "__dialog_state_changed" }, { dialogQueue: queue });
    });
    actions.answerDialog("r3", "Alice");
    expect(state.dialogs).toEqual([]);
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

  it("S_CONFIRM RV-001：host 已放弃（cleared）的 ask 不得被 reopen 复活", () => {
    // 根因链：host 超时/abort 现在也发 extension_ui_cleared（mobile-ui-context.ts），
    // 而 cleared 必须真正出队；否则条目仍以终态留在 Map 里，一次失败的 resend 就能把它拉回来。
    const queue = new ExtensionUiQueue();
    queue.enqueue(req);
    let state = reduceEvent(createInitialState(), { type: "extension_ui_request", request: req, seq: 1 } as HostEvent, { dialogQueue: queue });
    createAppActions(queue, () => undefined).answerDialog("r9", "A");
    // host 侧确认收到（respond）⇒ 发 cleared
    state = reduceEvent(state, { type: "extension_ui_cleared", sessionId: "s1", requestId: "r9", seq: 2 } as HostEvent, { dialogQueue: queue });
    expect(queue.get("r9"), "cleared 必须真正出队，不能只过滤投影数组").toBeUndefined();
    // 此时才发生发送失败（例如 WS 乱序/延迟 reject）⇒ 不得复活
    state = reduceEvent(state, { type: "__dialog_send_failed", request: req, message: "lost" } as never, { dialogQueue: queue });
    expect(state.dialogs, "host 已放弃的 ask 不得重新弹窗").toHaveLength(0);
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

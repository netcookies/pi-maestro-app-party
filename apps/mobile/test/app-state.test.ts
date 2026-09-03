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
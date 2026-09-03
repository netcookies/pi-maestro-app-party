/**
 * AppState — 移动端全局状态 reducer
 *
 * 将 HostEvent 流投影为屏幕需要的状态：
 * - sessions: 会话列表
 * - maestroState: 调度仪表盘数据
 * - monitorState: 窗口监控数据
 * - dialogs: 待处理的 ask 弹窗（ExtensionUiQueue 管理）
 */
import type {
  HostEvent,
  MaestroState,
  MonitorState,
  SessionState,
  TimelineItem,
} from "@maestro-mobile/shared";
import { ExtensionUiQueue, type DialogEntry } from "./extension-ui-queue.js";

export interface AppState {
  connectionStatus: string;
  sessions: Map<string, SessionState>;
  timelines: Map<string, TimelineItem[]>;
  maestro: MaestroState | null;
  monitor: MonitorState | null;
  dialogs: DialogEntry[];
  lastError: string | null;
}

export function createInitialState(): AppState {
  return {
    connectionStatus: "disconnected",
    sessions: new Map(),
    timelines: new Map(),
    maestro: null,
    monitor: null,
    dialogs: [],
    lastError: null,
  };
}

export interface AppStateDeps {
  dialogQueue?: ExtensionUiQueue;
}

/** 纯 reducer：处理一个 HostEvent，返回新状态（不可变更新） */
export function reduceEvent(state: AppState, event: HostEvent, deps: AppStateDeps = {}): AppState {
  const queue = deps.dialogQueue;
  switch (event.type) {
    case "host_status":
      return { ...state, connectionStatus: event.status };

    case "session_updated": {
      const sessions = new Map(state.sessions);
      sessions.set(event.session.id, event.session);
      return { ...state, sessions };
    }

    case "timeline_item": {
      const timelines = new Map(state.timelines);
      const items = timelines.get(event.sessionId) ?? [];
      timelines.set(event.sessionId, [...items, event.item]);
      return { ...state, timelines };
    }

    case "timeline_delta": {
      const timelines = new Map(state.timelines);
      const items = timelines.get(event.sessionId) ?? [];
      const updated = items.map((item) =>
        item.id === event.itemId ? { ...item, text: item.text + event.delta } : item,
      );
      timelines.set(event.sessionId, updated);
      return { ...state, timelines };
    }

    case "maestro_state":
      return { ...state, maestro: event.state };

    case "monitor_state":
      return { ...state, monitor: event.state };

    case "extension_ui_request": {
      if (!queue) return state;
      queue.enqueue(event.request);
      return { ...state, dialogs: queue.pendingDialogs };
    }

    case "extension_ui_cleared": {
      if (!queue) return state;
      // 从队列中移除已处理的弹窗
      const remaining = queue.pendingDialogs.filter((d) => d.request.id !== event.requestId);
      return { ...state, dialogs: remaining };
    }

    case "command_error":
    case "error":
      return { ...state, lastError: event.message };

    default:
      return state;
  }
}

export interface AppActions {
  answerDialog(requestId: string, value: string | string[]): void;
  cancelDialog(requestId: string): void;
}

export function createAppActions(
  queue: ExtensionUiQueue,
  responder: (sessionId: string, requestId: string, response: unknown) => void,
): AppActions {
  return {
    answerDialog(requestId, value) {
      const entry = queue.get(requestId);
      if (!entry) return;
      const response = Array.isArray(value)
        ? queue.answer(requestId, { selected: value })
        : queue.answer(requestId, { value });
      if (response) {
        responder(entry.request.sessionId, requestId, response);
      }
    },
    cancelDialog(requestId) {
      const entry = queue.get(requestId);
      if (!entry) return;
      const response = queue.cancel(requestId);
      if (response) {
        responder(entry.request.sessionId, requestId, response);
      }
    },
  };
}
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
import { ExtensionUiQueue, type DialogEntry } from "./extension-ui-queue";

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

/** 内部事件：批量替换 timeline（App 打开会话后拉取 snapshot 触发） */
export interface InternalEvent {
  type: "__history_load";
  sessionId: string;
  items: TimelineItem[];
  seq: number;
}

/** 内部事件：向前追加更早的历史（懒加载翻页） */
export interface HistoryPrependEvent {
  type: "__history_prepend";
  sessionId: string;
  items: TimelineItem[];
  seq: number;
}

/** 纯 reducer：处理一个 HostEvent，返回新状态（不可变更新）
 * 额外支持内部事件 __history_load（批量替换 timeline） */
export function reduceEvent(state: AppState, event: HostEvent | InternalEvent | HistoryPrependEvent, deps: AppStateDeps = {}): AppState {
  const queue = deps.dialogQueue;
  if (event.type === "__history_load") {
    const timelines = new Map(state.timelines);
    timelines.set(event.sessionId, event.items.length > 0 ? event.items : []);
    return { ...state, timelines };
  }
  if (event.type === "__history_prepend") {
    const timelines = new Map(state.timelines);
    const existing = timelines.get(event.sessionId) ?? [];
    // 去重：跳过已存在的 id
    const existingIds = new Set(existing.map((t) => t.id));
    const fresh = event.items.filter((t) => !existingIds.has(t.id));
    timelines.set(event.sessionId, [...fresh, ...existing]);
    return { ...state, timelines };
  }
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
        ? queue.answer(requestId, { selected: value as string[] })
        : queue.answer(requestId, { value: value as string });
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
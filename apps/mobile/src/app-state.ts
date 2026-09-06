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
  ExtensionUiResponse,
} from "@maestro-mobile/shared";
import { ExtensionUiQueue, type DialogEntry } from "./extension-ui-queue";
import { parseHostStatusMeta, type HostStatusMeta } from "./host-status";

export interface AppState {
  connectionStatus: string;
  /** host_status 对象载荷解析出的版本/maestro 检测元数据（设置页「版本与诊断」用；null = 待 Host 接入） */
  hostStatusMeta: HostStatusMeta | null;
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
    hostStatusMeta: null,
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

/** 内部事件：H4 微批 — 同一帧内的多个 HostEvent 顺序折叠为一次状态更新 */
export interface EventBatchEvent {
  type: "__event_batch";
  events: HostEvent[];
}

/** 纯 reducer：处理一个 HostEvent，返回新状态（不可变更新）
 * 额外支持内部事件 __history_load（批量替换 timeline）/ __event_batch（H4 微批） */
export function reduceEvent(state: AppState, event: HostEvent | InternalEvent | HistoryPrependEvent | EventBatchEvent, deps: AppStateDeps = {}): AppState {
  if (event && (event as EventBatchEvent).type === "__event_batch") {
    let s = state;
    for (const e of (event as EventBatchEvent).events) {
      s = reduceEvent(s, e, deps);
    }
    return s;
  }
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
    case "host_status": {
      const meta = parseHostStatusMeta(event.status);
      return {
        ...state,
        connectionStatus: typeof event.status === "string" ? event.status : state.connectionStatus,
        // 对象载荷（Host 首次连接推送 getStatus()）→ 提取版本元数据；字符串载荷不改元数据
        ...(meta ? { hostStatusMeta: meta } : null),
      };
    }

    case "host_info": {
      // Host 连接后独立推送 getStatus() 元数据；与 host_status 的对象载荷同一解析路径
      const meta = parseHostStatusMeta(event.info);
      return meta ? { ...state, hostStatusMeta: meta } : state;
    }

    case "session_updated": {
      const sessions = new Map(state.sessions);
      sessions.set(event.session.id, event.session);
      return { ...state, sessions };
    }

    case "timeline_item": {
      const timelines = new Map(state.timelines);
      const items = timelines.get(event.sessionId) ?? [];
      // P1-1 契约：相同 id 替换（host 对同一消息更新时复用稳定 id），否则追加
      const idx = items.findIndex((t) => t.id === event.item.id);
      const next = idx >= 0
        ? items.map((t, i) => (i === idx ? event.item : t))
        : [...items, event.item];
      timelines.set(event.sessionId, next);
      return { ...state, timelines };
    }

    case "timeline_delta": {
      const timelines = new Map(state.timelines);
      const items = timelines.get(event.sessionId) ?? [];
      // 未建条目时忽略（终态由 timeline_item 补齐，见 protocol.ts 契约注释）
      const known = items.some((t) => t.id === event.itemId);
      if (!known) return state;
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
      const response = buildDialogResponse(queue, requestId, value);
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

/**
 * 按请求方法构造响应（P1-2）：
 * - confirm：sendConfirmation 约定 "confirmed:true"/"confirmed:false"，
 *   转 { confirmed: bool }（host 端 mobile-ui-context.ts 只认 confirmed 字段；
 *   发 { value: "yes" } 会被解析成 false —— 语义反转缺陷）
 * - 其他：数组 → selected，字符串 → value（与 select/input//editor 的 host 解析器一致）
 */
export const CONFIRM_TRUE = "confirmed:true";
export const CONFIRM_FALSE = "confirmed:false";

function buildDialogResponse(
  queue: ExtensionUiQueue,
  requestId: string,
  value: string | string[],
): ExtensionUiResponse | undefined {
  const entry = queue.get(requestId);
  if (!entry) return undefined;
  if (entry.request.method === "confirm" && typeof value === "string") {
    if (value === CONFIRM_TRUE || value === CONFIRM_FALSE) {
      return queue.answer(requestId, { confirmed: value === CONFIRM_TRUE });
    }
    return queue.answer(requestId, { confirmed: value === "yes" });
  }
  if (Array.isArray(value)) {
    return queue.answer(requestId, { selected: value as string[] });
  }
  return queue.answer(requestId, { value: value as string });
}
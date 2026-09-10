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
  ExtensionUiRequest,
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

/**
 * 内部事件：弹窗应答发送失败（断连/连接丢失）。
 *
 * 为什么单独开一个本地类型而不复用 host 的 `error`（ISS-20260910 review F-002）：
 * `error` 是 HostEvent，`seq` 必填且属于 host 事件流序列；本地合成帧只能填 seq:0，
 * 一旦引入 seq 去重/回放过滤就会不一致。本类型不进入 HostEvent 域，语义上也不声称是 host 推的。
 *
 * 为什么需要它（F-001）：弹窗只在 extension_ui_request / extension_ui_cleared 时重投影，
 * 而 host 的 cleared 依赖它收到我们的响应 ⇒ 断连时响应永不会送达，弹窗既不消失
 * 也无错误提示（原 responder 的 .catch(() => undefined) 静默吞掉）。本事件同时负责
 * 把弹窗重新入队（保留用户已选答案）与提示错误。
 */
export interface DialogSendFailedEvent {
  type: "__dialog_send_failed";
  request: ExtensionUiRequest;
  message: string;
}

/**
 * 内部事件：客户端本地产生的错误提示（如断连导致命令被 settle）。
 *
 * 为什么不复用 host 的 `error`（ISS-20260910 review F-002）：`error` 属于 HostEvent 结合类型，
 * `seq` 为必填且语义上是 host 事件流序号；本地合成帧只能填占位 0，一旦引入 seq 去重/
 * 增量回放过滤就会与真 host 帧歧义。展示行为与 `error` 一致（写 lastError），但域分离。
 */
export interface LocalErrorEvent {
  type: "__local_error";
  message: string;
}

/** reducer 可接受的全部 action：host 事件流 + 本地内部事件 */
export type AppAction =
  | HostEvent
  | InternalEvent
  | HistoryPrependEvent
  | EventBatchEvent
  | DialogSendFailedEvent
  | LocalErrorEvent;

/** 纯 reducer：处理一个 HostEvent，返回新状态（不可变更新）
 * 额外支持内部事件 __history_load（批量替换 timeline）/ __event_batch（H4 微批）/ __dialog_send_failed */
export function reduceEvent(state: AppState, event: AppAction, deps: AppStateDeps = {}): AppState {
  if (event && (event as EventBatchEvent).type === "__event_batch") {
    let s = state;
    for (const e of (event as EventBatchEvent).events) {
      s = reduceEvent(s, e, deps);
    }
    return s;
  }
  const queue = deps.dialogQueue;
  if (event.type === "__dialog_send_failed") {
    // 重新入队同 id 弹窗（enqueue 按 id set，不会重复）并刷新计时，使用户已选答案不丢；
    // 同时写 lastError，否则从用户视角看是「点了没反应」。
    let dialogs = state.dialogs;
    if (queue) {
      queue.enqueue(event.request);
      dialogs = queue.pendingDialogs;
    }
    return { ...state, dialogs, lastError: event.message };
  }
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

    case "__local_error":
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
  responder: (
    sessionId: string,
    requestId: string,
    response: unknown,
    /** 原 request：发送失败时由调用方交给 reducer 重新入队（ISS-20260910 review F-001） */
    request: ExtensionUiRequest,
  ) => void,
): AppActions {
  return {
    answerDialog(requestId, value) {
      const entry = queue.get(requestId);
      if (!entry) return;
      const response = buildDialogResponse(queue, requestId, value);
      if (response) {
        responder(entry.request.sessionId, requestId, response, entry.request);
      }
    },
    cancelDialog(requestId) {
      const entry = queue.get(requestId);
      if (!entry) return;
      const response = queue.cancel(requestId);
      if (response) {
        responder(entry.request.sessionId, requestId, response, entry.request);
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
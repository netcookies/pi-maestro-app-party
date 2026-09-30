/**
 * HostStore — 全局连接与状态管理（React Context）
 *
 * 职责：
 * - 持有 HostClient（WS 连接）
 * - 持有 AppState（事件流投影）
 * - 暴露 connect / disconnect / sendPrompt / answerDialog 等动作
 */
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, useCallback } from "react";
import {
  isSessionTargetIdentity,
  sessionTargetKey,
  type ExtensionUiRequest,
  type HostEvent,
  type HostSessionList,
  type MaestroState,
  type MonitorState,
  type SessionTargetIdentity,
  type TimelineItem,
  type SessionUsageSummary,
  type ExecutionProjection,
  type DesktopPlanResponse,
} from "@maestro-mobile/shared";
import { HostClient, type ConnectionState } from "./host-client";

import { isServerSessionPresentation, filterSessionsByVisibility } from "./host-session-pagination";
import { ExtensionUiQueue } from "./extension-ui-queue";
import { PlanQueue } from "./plan-queue";
import { describeSendFailure } from "./delivery-error";
import { monitorStateFromCommandResult, executionProjectionsFromCommandResult } from "./monitor-data";

import {
  createInitialState,
  reduceEvent,
  createAppActions,
  createPlanActions,
  type AppState,
  type AppAction,
  type DialogSendFailedEvent,
} from "./app-state";

export interface HostStoreValue {
  state: AppState;
  connectionState: ConnectionState;
  isConnected: boolean;
  hostUrl: string;
  /** 当前连接使用的 token（P1-5：图片 URL 携带凭证） */
  token?: string;
  connect(url: string, token?: string): void;
  disconnect(): void;

  listHostSessions(options?: { cwd?: string; limit?: number; cursor?: string; query?: string; includeMonitor?: boolean; sessionIds?: string[]; latestForCwds?: string[] }): Promise<HostSessionList>;
  refreshMaestroState(): Promise<MaestroState | null>;
  refreshMonitor(): Promise<MonitorState>;
  refreshExecutionProjections(): Promise<ExecutionProjection[]>;
  loadSessionHistory(sessionId: string, targetKey?: string): Promise<void>;
  loadMoreHistory(sessionId: string, count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }>;
  searchHistory(sessionId: string, keyword: string, maxResults?: number, previewLength?: number): Promise<{ matches: { index: number; text: string; kind: string }[]; totalEntries: number }>;
  listModels(sessionId: string): Promise<{ id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[]>;
  listSkills(sessionId: string): Promise<{ name: string; description?: string }[]>;
  getMaestroSettings(): Promise<{ files: { key: string; label: string; path: string; data: Record<string, unknown> }[]; observedAt: string }>;
  /** 会话 token 用量（JSONL 聚合 + SDK context）；目标会话未打开时返回 null */
  fetchSessionUsage(sessionId: string): Promise<SessionUsageSummary | null>;
  updateMaestroSettings(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  setModel(sessionId: string, modelId: string, provider?: string): Promise<{ ok: boolean; error?: string }>;
  setThinking(sessionId: string, level: string): Promise<{ ok: boolean; error?: string }>;

  sendPrompt(sessionId: string, message: string, images?: { data: string; mime: string }[]): Promise<void>;
  sendSteer(sessionId: string, message: string): Promise<void>;
  sendAbort(sessionId: string): Promise<void>;
  answerDialog(requestId: string, value: string | string[]): void;
  cancelDialog(requestId: string): void;
  respondPlan(requestId: string, response: DesktopPlanResponse, target?: SessionTargetIdentity): void;
  cancelPlan(requestId: string, target?: SessionTargetIdentity): void;
  lastError: string | null;
  /** 清除本地错误提示（可关闭横幅）；只影响本地提示，不影响 host 事件流。 */
  clearError(): void;
}

export function normalizeThinkingResult(result: unknown): { ok: boolean; error?: string } {
  if (result === null || result === undefined) return { ok: true };
  if (!result || typeof result !== "object") return { ok: false, error: "Invalid thinking level response" };
  const value = result as { ok?: unknown; error?: unknown };
  if (value.ok === false) return { ok: false, error: typeof value.error === "string" ? value.error : "thinking level change failed" };
  return { ok: true };
}

const HostStoreContext = createContext<HostStoreValue | null>(null);

function isSnapshotProjectionEvent(event: HostEvent): boolean {
  return event.type === "session_updated" || event.type === "timeline_item" || event.type === "timeline_delta";
}

export function HostStoreProvider({ children }: { children: React.ReactNode }) {
  const queueRef = useRef(new ExtensionUiQueue());
  const planQueueRef = useRef(new PlanQueue());
  const clientRef = useRef<HostClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [hostUrl, setHostUrl] = useState<string>("");
  const [token, setToken] = useState<string | undefined>(undefined);
  // P2-2：重连前记录的活动会话，重连成功后自动补拉 snapshot，避免断线期间消息永久丢失
  const activeSessionRef = useRef<string | null>(null);
  /** Current active exact target for each session id; sibling targets are retained by target key. */
  const sessionTargetsRef = useRef(new Map<string, SessionTargetIdentity>());
  const activeTargetKeysRef = useRef(new Map<string, string>());
  const reloadGenerationRef = useRef(0);

  // H4：实时事件微批 — 同一帧内的 WS 事件合并为一次 reducer 执行，
  // 避免流式 delta 逐条触发全局重渲染。16ms 窗口上限（≈1 帧）。
  const eventBufferRef = useRef<HostEvent[]>([]);
  const snapshotEventBuffersRef = useRef(new Map<string, { generation: number; events: HostEvent[] }>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushBufferedEvents = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = eventBufferRef.current;
    eventBufferRef.current = [];
    if (buffered.length === 0) return;
    if (buffered.length === 1) {
      dispatch(buffered[0]);
      return;
    }
    dispatch({ type: "__event_batch", events: buffered });
  }, []);
  const flushPendingEvents = useCallback(() => {
    if (!flushTimerRef.current) return;
    clearTimeout(flushTimerRef.current);
    flushBufferedEvents();
  }, [flushBufferedEvents]);
  const dispatchBuffered = useCallback((event: HostEvent) => {
    if ("target" in event && event.target && isSessionTargetIdentity(event.target)) {
      sessionTargetsRef.current.set(sessionTargetKey(event.target), event.target);
    }
    if ("target" in event && event.target && isSnapshotProjectionEvent(event)) {
      const pendingSnapshot = snapshotEventBuffersRef.current.get(sessionTargetKey(event.target));
      if (pendingSnapshot) {
        pendingSnapshot.events.push(event);
        return;
      }
    }
    // 高优先级事件直发：连接状态/错误/弹窗不能等 16ms
    if (
      event.type === "host_status" || event.type === "host_info" || event.type === "error"
      || event.type === "extension_ui_request" || event.type === "extension_ui_cleared"
    ) {
      // 先冲刷已缓冲事件保持顺序，再直发
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushBufferedEvents();
      }
      dispatch(event);
      return;
    }
    eventBufferRef.current.push(event);
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushBufferedEvents, 16);
    }
  }, [flushBufferedEvents]);

  const clearBufferedEvents = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    eventBufferRef.current = [];
    snapshotEventBuffersRef.current.clear();
  }, []);

  const [state, dispatch] = useReducer(
    // action 类型必须是 reducer 实际接受的 union；之前窄化为 HostEvent 使所有内部事件都要 as never 强转
    (s: AppState, e: AppAction) => reduceEvent(s, e, { dialogQueue: queueRef.current, planQueue: planQueueRef.current }),
    undefined,
    createInitialState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const getClient = useCallback((): HostClient => {
    if (!clientRef.current) {
      throw new Error("HostClient not initialized");
    }
    return clientRef.current;
  }, []);

  const targetForSession = useCallback((sessionId: string, targetKey?: string): SessionTargetIdentity | undefined => {
    const key = targetKey ?? activeTargetKeysRef.current.get(sessionId);
    if (key) {
      const target = sessionTargetsRef.current.get(key);
      return target?.sessionId === sessionId ? target : undefined;
    }
    const matches = [...sessionTargetsRef.current.values()].filter((target) => target.sessionId === sessionId);
    return matches.length === 1 ? matches[0] : undefined;
  }, []);

  const targetOptions = useCallback((sessionId: string): { target: SessionTargetIdentity } => {
    const target = targetForSession(sessionId);
    if (!target) throw new Error(`Exact session target is required for ${sessionId}`);
    return { target };
  }, [targetForSession]);

  const beginSnapshotBuffer = useCallback((target: SessionTargetIdentity | undefined, generation: number): string | undefined => {
    flushPendingEvents();
    if (!target) return undefined;
    const key = sessionTargetKey(target);
    const existing = snapshotEventBuffersRef.current.get(key);
    snapshotEventBuffersRef.current.set(key, { generation, events: existing?.events ?? [] });
    return key;
  }, [flushPendingEvents]);

  const releaseSnapshotBuffer = useCallback((key: string | undefined, generation: number, wireSeq?: number) => {
    if (!key) return;
    const pending = snapshotEventBuffersRef.current.get(key);
    if (!pending || pending.generation !== generation) return;
    snapshotEventBuffersRef.current.delete(key);
    const events = wireSeq === undefined
      ? pending.events
      : pending.events.filter((event) => event.seq >= wireSeq);
    if (events.length === 1) dispatch(events[0]);
    else if (events.length > 1) dispatch({ type: "__event_batch", events });
  }, []);

  const connect = useCallback((url: string, tok?: string) => {
    clearBufferedEvents();
    clientRef.current?.close();
    sessionTargetsRef.current.clear();
    activeTargetKeysRef.current.clear();
    setHostUrl(url);
    setToken(tok);
    const client = new HostClient({
      url,
      token: tok,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 15000,
      onEvent: dispatchBuffered,
      onRevisionChange: (revision) => dispatch({ type: "__revision", revision }),
      // ISS-002：断连导致的命令失败必须提示到 UI（app/session.tsx 承诺「错误由 store.lastError 提示」，
      // 但 lastError 原本只由 host 推的事件写入，本地 reject 进不了 reducer）。
      // ISS-20260910 review F-002：走本地内部事件而非合成 host `error` 帧，避免 seq 占位 0 的域歧义。
      onConnectionError: (message) => {
        dispatch({ type: "__local_error", message });
      },
      onStateChange: (s) => {
        setConnectionState(s);
        if (s === "disconnected" || s === "reconnecting") {
          clearBufferedEvents();
          dispatch({ type: "__connection_reset", connectionGeneration: stateRef.current.connectionGeneration + 1 });
        }
        // P2-2：断线重连成功后，为重连前活动的会话补拉 snapshot（代次号防陈旧响应覆盖新状态）
        if (s === "connected") {
          const projectionConnectionGeneration = stateRef.current.connectionGeneration;
          void client.getExecutionProjections()
            .then((result) => {
              const projections = executionProjectionsFromCommandResult(result);
              if (clientRef.current !== client || stateRef.current.connectionGeneration !== projectionConnectionGeneration) return;
              dispatch({ type: "__execution_projections_load", projections, revision: result.revision, connectionGeneration: projectionConnectionGeneration });
            })
            .catch(() => undefined);
          void client.sendCommand({ type: "get_maestro_state" })
            .then((result) => {
              if (result && typeof result === "object" && Array.isArray((result as { schedules?: unknown }).schedules)) {
                dispatch({ type: "maestro_state", state: result as MaestroState, seq: 0 });
              }
            })
            .catch(() => undefined);
          void client.sendCommand({ type: "list_host_sessions", limit: 100 })
            .then((result) => {
              if (clientRef.current !== client || stateRef.current.connectionGeneration !== projectionConnectionGeneration) return;
              if (!result || typeof result !== "object" || !Array.isArray((result as { sessions?: unknown }).sessions)) return;
              const list = result as HostSessionList;
              for (const session of list.sessions) {
                if (!session.target || !isSessionTargetIdentity(session.target)
                  || session.target.sessionId !== session.sessionId
                  || session.target.endpointId !== session.endpointId
                  || (session.targetKey !== undefined && session.targetKey !== sessionTargetKey(session.target))) continue;
                const key = sessionTargetKey(session.target);
                sessionTargetsRef.current.set(key, session.target);
              }
              dispatch({
                type: "__host_session_list_load",
                list: { ...list, sessions: filterSessionsByVisibility(list.sessions, "session_list") },
                connectionGeneration: projectionConnectionGeneration,
              });
            })
            .catch(() => undefined);
          const sessionId = activeSessionRef.current;
          if (sessionId && client.isConnected) {
            const generation = ++reloadGenerationRef.current;
            const target = targetForSession(sessionId);
            if (!target) return;
            const snapshotBufferKey = beginSnapshotBuffer(target, generation);
            void client
              .getSnapshot(sessionId, target)
              .then((snapshot) => {
                if (generation !== reloadGenerationRef.current) {
                  releaseSnapshotBuffer(snapshotBufferKey, generation);
                  return;
                }
                dispatch({ type: "__snapshot_load", session: snapshot.session, items: snapshot.timeline, seq: snapshot.nextSeq, ...(typeof snapshot.wireSeq === "number" ? { wireSeq: snapshot.wireSeq } : {}), target });
                releaseSnapshotBuffer(snapshotBufferKey, generation, snapshot.wireSeq);
              })
              .catch(() => releaseSnapshotBuffer(snapshotBufferKey, generation));
          }
        }
      },
    });
    clientRef.current = client;
    client.connect();
  }, [beginSnapshotBuffer, clearBufferedEvents, dispatchBuffered, releaseSnapshotBuffer, targetForSession]);

  const disconnect = useCallback(() => {
    clearBufferedEvents();
    clientRef.current?.close();
    clientRef.current = null;
    queueRef.current.clearAll();
    planQueueRef.current.clearAll();
    activeSessionRef.current = null;
    sessionTargetsRef.current.clear();
    activeTargetKeysRef.current.clear();
    dispatch({ type: "__connection_reset", connectionGeneration: stateRef.current.connectionGeneration + 1 });
    setConnectionState("disconnected");
  }, [clearBufferedEvents]);

  // 冷启动自动连接：App 打开即恢复上次 Host 连接（方向 A 重构后连接卡移入 host-sessions tab，
  // 而 bottom-tabs 默认 lazy mount —— 停留在工作台时永远没人发起连接。这里在 Provider 层兜底，
  // 读单连接参数键；深链配对（pair.tsx）会先写该键再跳转，时序天然正确。
  const autoConnectRef = useRef(false);
  useEffect(() => {
    if (autoConnectRef.current) return;
    autoConnectRef.current = true;
    void (async () => {
      const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
      let url = "";
      let tok = "";
      try {
        const raw = await AsyncStorage.getItem("maestro-mobile.host-connection");
        const saved = raw ? (JSON.parse(raw) as { hostUrl?: string; token?: string }) : null;
        if (saved?.hostUrl && /^wss?:\/\//.test(saved.hostUrl)) {
          url = saved.hostUrl;
          tok = saved.token ?? "";
        }
      } catch { /* 坏数据走兜底 */ }
      if (!url) {
        // 兜底：单键缺失时取配对列表第一条（多 Host 场景）
        const { loadPairedHosts } = await import("./paired-hosts");
        const list = await loadPairedHosts();
        if (list[0]) { url = list[0].hostUrl; tok = list[0].token; }
      }
      if (url) connect(url, tok.trim() || undefined);
    })();
  }, [connect]);

  const listHostSessions = useCallback(async (options: { cwd?: string; limit?: number; cursor?: string; query?: string; includeMonitor?: boolean; sessionIds?: string[]; latestForCwds?: string[] } = {}): Promise<HostSessionList> => {
    const result = await getClient().sendCommand({ type: "list_host_sessions", ...options });
    const list = result as HostSessionList;
    if (!list || !Array.isArray(list.sessions) || typeof list.observedAt !== "string") {
      throw new Error("Invalid session list response");
    }
    if (list.sessions.some((session) => session.presentation !== undefined && !isServerSessionPresentation(session.presentation))) {
      throw new Error("Invalid session presentation");
    }
    if (list.sessions.some((session) => session.target !== undefined && (
      !isSessionTargetIdentity(session.target)
      || session.target.sessionId !== session.sessionId
      || session.target.endpointId !== session.endpointId
      || (session.targetKey !== undefined && session.targetKey !== sessionTargetKey(session.target))
    ))) {
      throw new Error("Invalid session target");
    }
    for (const session of list.sessions) {
      if (!session.target || !isSessionTargetIdentity(session.target)) continue;
      const key = session.targetKey ?? sessionTargetKey(session.target);
      sessionTargetsRef.current.set(key, session.target);
    }
    return { ...list, sessions: filterSessionsByVisibility(list.sessions, options.includeMonitor ? "monitor_tab" : "session_list") };
  }, [getClient]);

  const refreshMaestroState = useCallback(async (): Promise<MaestroState | null> => {
    try {
      const state = await getClient().sendCommand({ type: "get_maestro_state" }) as MaestroState;
      if (!state || !Array.isArray(state.schedules)) throw new Error("Invalid Maestro state response");
      dispatch({ type: "maestro_state", state, seq: 0 });
      return state;
    } catch (error) {
      dispatch({ type: "__local_error", message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }, [dispatch, getClient]);

  const refreshMonitor = useCallback(async (): Promise<MonitorState> => {
    try {
      const monitor = monitorStateFromCommandResult(await getClient().sendCommand({ type: "get_monitor_state" }));
      dispatch({ type: "monitor_state", state: monitor, seq: 0 });
      return monitor;
    } catch (error) {
      dispatch({ type: "__local_error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [getClient, dispatch]);

  const refreshExecutionProjections = useCallback(async (): Promise<ExecutionProjection[]> => {
    try {
      const client = getClient();
      const projectionRequestGeneration = stateRef.current.connectionGeneration;
      const result = await client.getExecutionProjections();
      const projections = executionProjectionsFromCommandResult(result);
      if (projectionRequestGeneration !== stateRef.current.connectionGeneration || clientRef.current !== client) return projections;
      dispatch({ type: "__execution_projections_load", projections, revision: result.revision, connectionGeneration: projectionRequestGeneration });
      return projections;
    } catch (error) {
      dispatch({ type: "__local_error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [dispatch, getClient]);

  const clearError = useCallback(() => {
    dispatch({ type: "__local_error", message: "" });
  }, [dispatch]);

  const sendPrompt = useCallback(async (sessionId: string, message: string, images?: { data: string; mime: string }[]) => {
    try {
      await getClient().sendCommand({ type: "prompt", sessionId, ...targetOptions(sessionId), message, ...(images && images.length > 0 ? { images } : {}) });
    } catch (error) {
      // 投递失败必须可见：此前只 reject，调用方 catch 后静默保留草稿，用户无从得知消息未送达。
      // 走本地内部事件（不冒充 host 事件流的 error 帧，避开其必填 seq 语义）。
      dispatch({ type: "__local_error", message: describeSendFailure(error) });
      throw error;
    }
  }, [getClient, dispatch, targetOptions]);

  const listModels = useCallback(async (sessionId: string) => {
    const result = await getClient().sendCommand({ type: "list_models", sessionId, ...targetOptions(sessionId) });
    if (!Array.isArray(result)) {
      const error = result && typeof result === "object" && "error" in result ? String((result as { error?: unknown }).error ?? "") : "Invalid model list response";
      throw new Error(error || "Invalid model list response");
    }
    return result.filter((model): model is { id: string; provider: string; name: string; reasoning: boolean; vision: boolean } => {
      if (!model || typeof model !== "object") return false;
      const value = model as Record<string, unknown>;
      return typeof value.id === "string" && typeof value.provider === "string" && typeof value.name === "string";
    });
  }, [getClient, targetOptions]);

  const listSkills = useCallback(async (sessionId: string) => {
    const result = await getClient().sendCommand({ type: "list_skills", sessionId, ...targetOptions(sessionId) });
    if (!Array.isArray(result)) {
      const error = result && typeof result === "object" && "error" in result ? String((result as { error?: unknown }).error ?? "") : "Invalid skills response";
      throw new Error(error || "Invalid skills response");
    }
    return result.filter((skill): skill is { name: string; description?: string } => {
      if (!skill || typeof skill !== "object") return false;
      const value = skill as Record<string, unknown>;
      return typeof value.name === "string";
    });
  }, [getClient, targetOptions]);

  const getMaestroSettings = useCallback(async () => {
    const result = await getClient().sendCommand({ type: "get_maestro_settings" });
    return result as { files: { key: string; label: string; path: string; data: Record<string, unknown> }[]; observedAt: string };
  }, [getClient]);

  const updateMaestroSettings = useCallback(async (patch: Record<string, unknown>) => {
    const result = await getClient().sendCommand({ type: "update_maestro_settings", key: "settings", patch });
    return result as { ok: boolean; error?: string };
  }, [getClient]);

  const fetchSessionUsage = useCallback(async (sessionId: string): Promise<SessionUsageSummary | null> => {
    try {
      const result = await getClient().sendCommand({ type: "get_session_usage", sessionId, ...targetOptions(sessionId) });
      return result as SessionUsageSummary;
    } catch {
      return null;
    }
  }, [getClient, targetOptions]);

  const setModel = useCallback(async (sessionId: string, modelId: string, provider?: string) => {
    try {
      await getClient().sendCommand({ type: "set_model", sessionId, ...targetOptions(sessionId), modelId, ...(provider ? { provider } : {}) });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [getClient, targetOptions]);

  const setThinking = useCallback(async (sessionId: string, level: string) => {
    try {
      const result = normalizeThinkingResult(await getClient().sendCommand({ type: "set_thinking", sessionId, ...targetOptions(sessionId), level }));
      if (!result.ok) dispatch({ type: "__local_error", message: result.error ?? "thinking level change failed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "__local_error", message });
      return { ok: false, error: message };
    }
  }, [dispatch, getClient, targetOptions]);

  const sendSteer = useCallback(async (sessionId: string, message: string) => {
    await getClient().sendCommand({ type: "steer", sessionId, ...targetOptions(sessionId), message });
  }, [getClient, targetOptions]);

  const sendAbort = useCallback(async (sessionId: string) => {
    await getClient().sendCommand({ type: "abort", sessionId, ...targetOptions(sessionId) });
  }, [getClient, targetOptions]);

  const loadSessionHistory = useCallback(async (sessionId: string, targetKey?: string): Promise<void> => {
    const target = targetForSession(sessionId, targetKey);
    if (!target) {
      const error = new Error(`Exact session target is required for ${sessionId}`);
      dispatch({ type: "__local_error", message: error.message });
      throw error;
    }
    if (targetKey) activeTargetKeysRef.current.set(sessionId, targetKey);
    activeSessionRef.current = sessionId;
    const generation = ++reloadGenerationRef.current;
    const snapshotBufferKey = beginSnapshotBuffer(target, generation);
    try {
      const snapshot = await getClient().getSnapshot(sessionId, target);
      if (generation !== reloadGenerationRef.current) {
        releaseSnapshotBuffer(snapshotBufferKey, generation);
        return;
      }
      dispatch({ type: "__snapshot_load", session: snapshot.session, items: snapshot.timeline, seq: snapshot.nextSeq, ...(typeof snapshot.wireSeq === "number" ? { wireSeq: snapshot.wireSeq } : {}), ...(target ? { target } : {}) });
      releaseSnapshotBuffer(snapshotBufferKey, generation, snapshot.wireSeq);
    } catch (error) {
      releaseSnapshotBuffer(snapshotBufferKey, generation);
      dispatch({ type: "__local_error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, [beginSnapshotBuffer, getClient, dispatch, releaseSnapshotBuffer, targetForSession]);

  const loadMoreHistory = useCallback(async (sessionId: string, count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }> => {
    const target = targetForSession(sessionId);
    if (!target) throw new Error(`Exact session target is required for ${sessionId}`);
    const result = await getClient().sendCommand({ type: "load_more_history", sessionId, target, count });
    const r = result as { items: TimelineItem[]; hasMore: boolean; totalEntries: number };
    if (r.items?.length > 0) {
      dispatch({ type: "__history_prepend", sessionId, items: r.items, seq: 0, ...(target ? { target } : {}) });
    }
    return r;
  }, [getClient, dispatch, targetForSession]);

  const searchHistory = useCallback(async (sessionId: string, keyword: string, maxResults?: number, previewLength?: number) => {
    const result = await getClient().sendCommand({ type: "search_history", sessionId, ...targetOptions(sessionId), keyword, maxResults, previewLength });
    return result as { matches: { index: number; text: string; kind: string }[]; totalEntries: number };
  }, [getClient, targetOptions]);

  const actions = useMemo(
    () =>
      createAppActions(
        queueRef.current,
        (sessionId, requestId, response, request, requestTarget) => {
          const target = requestTarget;
          if (!target || target.sessionId !== sessionId) {
            dispatch({ type: "__local_error", message: `Exact session target is required for ask response ${requestId}` });
            return;
          }
          void getClient()
            .respondExtensionUi(sessionId, requestId, response, target)
            // ISS-20260910 review F-001：不得静默吞掉。弹窗只在 request/cleared 两个事件时重投影，
            // 而 host 的 cleared 依赖它收到本响应 ⇒ 断连时弹窗永不消失、用户答案丢失且无提示。
            // 走本地内部事件（不冒充 host 事件流的 error 帧，避开其必填 seq 语义）把弹窗重新入队并写 lastError。
            .catch((error: unknown) => {
              const event: DialogSendFailedEvent = {
                type: "__dialog_send_failed",
                request,
                message: error instanceof Error ? error.message : `ask 响应发送失败 (${requestId})`,
              };
              dispatch(event);
            });
        },
        () => dispatch({ type: "__dialog_state_changed" }),
      ),
    // dispatch 是 useReducer 返回的稳定标识，列入依赖不改变 memo 生命周期
    [getClient, dispatch, targetForSession],
  );

  const planActions = useMemo(
    () =>
      createPlanActions(
        planQueueRef.current,
        (sessionId, requestId, response, target) => getClient().respondDesktopPlan(sessionId, requestId, response, target),
        () => dispatch({ type: "__plan_state_changed" }),
        (message) => dispatch({ type: "__local_error", message }),
      ),
    [getClient, dispatch],
  );

  const answerDialog = useCallback(
    (requestId: string, value: string | string[]) => actions.answerDialog(requestId, value),
    [actions],
  );
  const cancelDialog = useCallback(
    (requestId: string) => actions.cancelDialog(requestId),
    [actions],
  );

  const cancelPlan = useCallback(
    (requestId: string, target?: SessionTargetIdentity) => planActions.cancelPlan(requestId, target),
    [planActions],
  );
  const respondPlan = useCallback(
    (requestId: string, response: DesktopPlanResponse, target?: SessionTargetIdentity) => planActions.respondPlan(requestId, response, target),
    [planActions],
  );

  const value = useMemo<HostStoreValue>(
    () => ({
      state,
      connectionState,
      isConnected: connectionState === "connected",
      hostUrl,
      token,
      connect,
      disconnect,
      listHostSessions,
      refreshMaestroState,
      refreshMonitor,
      refreshExecutionProjections,
      loadSessionHistory,
      loadMoreHistory,
      searchHistory,
      listModels,
      listSkills,
      getMaestroSettings,
      updateMaestroSettings,
      fetchSessionUsage,
      setModel,
      setThinking,
      sendPrompt,
      sendSteer,
      sendAbort,
      answerDialog,
      cancelDialog,
      respondPlan,
      cancelPlan,
      lastError: state.lastError,
      clearError,
    }),
    [state, connectionState, hostUrl, token, connect, disconnect, listHostSessions, refreshMaestroState, refreshMonitor, refreshExecutionProjections, loadSessionHistory, loadMoreHistory, searchHistory, listModels, listSkills, getMaestroSettings, updateMaestroSettings, fetchSessionUsage, setModel, setThinking, sendPrompt, sendSteer, sendAbort, answerDialog, cancelDialog, respondPlan, cancelPlan, clearError],

  );

  return <HostStoreContext.Provider value={value}>{children}</HostStoreContext.Provider>;
}

export function useHost(): HostStoreValue {
  const value = useContext(HostStoreContext);
  if (!value) {
    throw new Error("useHost must be used within HostStoreProvider");
  }
  return value;
}

export type { ExtensionUiRequest };

/**
 * HostStore — 全局连接与状态管理（React Context）
 *
 * 职责：
 * - 持有 HostClient（WS 连接）
 * - 持有 AppState（事件流投影）
 * - 暴露 connect / disconnect / sendPrompt / answerDialog 等动作
 */
import React, { createContext, useContext, useMemo, useReducer, useRef, useState, useCallback } from "react";
import type { ExtensionUiRequest, HostEvent, HostSessionList, LiveSessionList, TimelineItem, SessionUsageSummary } from "@maestro-mobile/shared";
import { HostClient, type ConnectionState } from "./host-client";
import { ExtensionUiQueue } from "./extension-ui-queue";
import {
  createInitialState,
  reduceEvent,
  createAppActions,
  type AppState,
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
  openSession(cwd: string): Promise<string>;
  openExistingSession(sessionFile: string, cwd: string): Promise<string>;
  /** 关闭 host 上的会话 runner（P2-4：避免重复 open 泄漏旧实例） */
  closeSession(sessionId: string): Promise<void>;
  listHostSessions(cwd?: string): Promise<HostSessionList>;
  listLiveSessions(): Promise<LiveSessionList>;
  loadSessionHistory(sessionId: string): Promise<void>;
  loadMoreHistory(sessionId: string, count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }>;
  searchHistory(sessionId: string, keyword: string, maxResults?: number, previewLength?: number): Promise<{ matches: { index: number; text: string; kind: string }[]; totalEntries: number }>;
  listModels(sessionId: string): Promise<{ id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[]>;
  listSkills(sessionId: string): Promise<{ name: string; description?: string }[]>;
  getMaestroSettings(): Promise<{ files: { key: string; label: string; path: string; data: Record<string, unknown> }[]; observedAt: string }>;
  /** 会话 token 用量（JSONL 聚合 + SDK context）；目标会话未打开时返回 null */
  fetchSessionUsage(sessionId: string): Promise<SessionUsageSummary | null>;
  fetchMonitorState(): Promise<void>;
  updateMaestroSettings(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  setModel(sessionId: string, modelId: string): Promise<{ ok: boolean; error?: string }>;
  setThinking(sessionId: string, level: string): Promise<{ ok: boolean; error?: string }>;
  compactSession(sessionId: string, customInstructions?: string): Promise<{ ok: boolean; error?: string }>;
  renameSession(sessionId: string, name: string): Promise<{ ok: boolean; error?: string }>;
  sendPrompt(sessionId: string, message: string, images?: { data: string; mime: string }[]): Promise<void>;
  sendSteer(sessionId: string, message: string): Promise<void>;
  /** 跨窗口监督发送：未打开的窗口会被 Host 接管（返回 tookOver=true） */
  sendSteerWindow(endpointId: string, cwd: string, message: string): Promise<{ ok: boolean; sessionId: string; tookOver: boolean; error?: string }>;
  sendAbort(sessionId: string): Promise<void>;
  answerDialog(requestId: string, value: string | string[]): void;
  cancelDialog(requestId: string): void;
  lastError: string | null;
}

const HostStoreContext = createContext<HostStoreValue | null>(null);
export function HostStoreProvider({ children }: { children: React.ReactNode }) {
  const queueRef = useRef(new ExtensionUiQueue());
  const clientRef = useRef<HostClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [hostUrl, setHostUrl] = useState<string>("");
  const [token, setToken] = useState<string | undefined>(undefined);
  // P2-2：重连前记录的活动会话，重连成功后自动补拉 snapshot，避免断线期间消息永久丢失
  const activeSessionRef = useRef<string | null>(null);
  const reloadGenerationRef = useRef(0);

  const [state, dispatch] = useReducer(
    (s: AppState, e: HostEvent) => reduceEvent(s, e, { dialogQueue: queueRef.current }),
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

  const connect = useCallback((url: string, tok?: string) => {
    clientRef.current?.close();
    setHostUrl(url);
    setToken(tok);
    const client = new HostClient({
      url,
      token: tok,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 15000,
      onEvent: (event) => dispatch(event),
      onStateChange: (s) => {
        setConnectionState(s);
        // P2-2：断线重连成功后，为重连前活动的会话补拉 snapshot（代次号防陈旧响应覆盖新状态）
        if (s === "connected") {
          const sessionId = activeSessionRef.current;
          if (sessionId && client.isConnected) {
            const generation = ++reloadGenerationRef.current;
            void client
              .getSnapshot(sessionId)
              .then((snapshot) => {
                if (generation !== reloadGenerationRef.current) return; // 已被更新的拉取取代
                dispatch({ type: "__history_load", sessionId, items: snapshot.timeline, seq: snapshot.nextSeq } as never);
                dispatch({ type: "session_updated", session: snapshot.session, seq: snapshot.nextSeq } as never);
              })
              .catch(() => undefined);
          }
        }
      },
    });
    clientRef.current = client;
    client.connect();
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    queueRef.current.clearAll();
    activeSessionRef.current = null;
    setConnectionState("disconnected");
  }, []);

  const openSession = useCallback(async (cwd: string): Promise<string> => {
    const result = await getClient().sendCommand({ type: "open_session", cwd, mode: "create" });
    const r = result as { sessionId?: string };
    return r.sessionId ?? "";
  }, [getClient]);

  const openExistingSession = useCallback(async (sessionFile: string, cwd: string): Promise<string> => {
    const result = await getClient().sendCommand({ type: "open_session", cwd, mode: "create", sessionFile });
    const r = result as { sessionId?: string };
    return r.sessionId ?? "";
  }, [getClient]);

  const closeSession = useCallback(async (sessionId: string): Promise<void> => {
    try {
      await getClient().sendCommand({ type: "close_session", sessionId });
    } catch {
      // 会话可能已不存在，忽略
    }
  }, [getClient]);

  const listHostSessions = useCallback(async (cwd?: string): Promise<HostSessionList> => {
    const result = await getClient().sendCommand({ type: "list_host_sessions", cwd });
    return result as HostSessionList;
  }, [getClient]);

  const listLiveSessions = useCallback(async (): Promise<LiveSessionList> => {
    const result = await getClient().sendCommand({ type: "list_live_sessions" });
    return result as LiveSessionList;
  }, [getClient]);

  const sendPrompt = useCallback(async (sessionId: string, message: string, images?: { data: string; mime: string }[]) => {
    await getClient().sendCommand({ type: "prompt", sessionId, message, ...(images && images.length > 0 ? { images } : {}) });
  }, [getClient]);

  const listModels = useCallback(async (sessionId: string) => {
    const result = await getClient().sendCommand({ type: "list_models", sessionId });
    return result as { id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[];
  }, [getClient]);

  const listSkills = useCallback(async (sessionId: string) => {
    const result = await getClient().sendCommand({ type: "list_skills", sessionId });
    return result as { name: string; description?: string }[];
  }, [getClient]);

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
      const result = await getClient().sendCommand({ type: "get_session_usage", sessionId });
      return result as SessionUsageSummary;
    } catch {
      return null;
    }
  }, [getClient]);

  const fetchMonitorState = useCallback(async (): Promise<void> => {
    try {
      // host 已用共享 projector 投影好 MonitorState；运行时校验后再 dispatch（防异常/恶意载荷）
      const result = await getClient().sendCommand({ type: "get_monitor_state" }) as unknown;
      if (
        result && typeof result === "object" && !Array.isArray(result)
        && Array.isArray((result as { windows?: unknown }).windows)
      ) {
        dispatch({ type: "monitor_state", state: result } as unknown as Parameters<typeof dispatch>[0]);
      }
    } catch {
      // 静默
    }
  }, [getClient]);

  const setModel = useCallback(async (sessionId: string, modelId: string) => {
    const result = await getClient().sendCommand({ type: "set_model", sessionId, modelId });
    return result as { ok: boolean; error?: string };
  }, [getClient]);

  const setThinking = useCallback(async (sessionId: string, level: string) => {
    const result = await getClient().sendCommand({ type: "set_thinking", sessionId, level });
    return result as { ok: boolean; error?: string };
  }, [getClient]);

  const compactSession = useCallback(async (sessionId: string, customInstructions?: string) => {
    const result = await getClient().sendCommand({ type: "compact", sessionId, customInstructions });
    return result as { ok: boolean; error?: string };
  }, [getClient]);

  const renameSession = useCallback(async (sessionId: string, name: string) => {
    const result = await getClient().sendCommand({ type: "rename_session", sessionId, name });
    return result as { ok: boolean; error?: string };
  }, [getClient]);

  const sendSteer = useCallback(async (sessionId: string, message: string) => {
    await getClient().sendCommand({ type: "steer", sessionId, message });
  }, [getClient]);

  const sendSteerWindow = useCallback(async (endpointId: string, cwd: string, message: string): Promise<{ ok: boolean; sessionId: string; tookOver: boolean; error?: string }> => {
    const result = await getClient().sendCommand({ type: "steer_window", endpointId, cwd, message });
    return result as { ok: boolean; sessionId: string; tookOver: boolean; error?: string };
  }, [getClient]);

  const sendAbort = useCallback(async (sessionId: string) => {
    await getClient().sendCommand({ type: "abort", sessionId });
  }, [getClient]);

  const loadSessionHistory = useCallback(async (sessionId: string): Promise<void> => {
    // 记录活动会话：断线重连成功后自动补拉 snapshot（P2-2）
    activeSessionRef.current = sessionId;
    try {
      const snapshot = await getClient().getSnapshot(sessionId);
      const generation = ++reloadGenerationRef.current;
      dispatch({ type: "__history_load", sessionId, items: snapshot.timeline, seq: snapshot.nextSeq } as never);
      // 同时写入 session 状态（model/title 等），否则会话页显示 no model
      dispatch({ type: "session_updated", session: snapshot.session, seq: snapshot.nextSeq } as never);
    } catch {
      // snapshot 失败静默（历史不可见但不阻塞）
    }
  }, [getClient]);

  const loadMoreHistory = useCallback(async (sessionId: string, count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }> => {
    const result = await getClient().sendCommand({ type: "load_more_history", sessionId, count });
    const r = result as { items: TimelineItem[]; hasMore: boolean; totalEntries: number };
    if (r.items?.length > 0) {
      dispatch({ type: "__history_prepend", sessionId, items: r.items, seq: 0 } as never);
    }
    return r;
  }, [getClient]);

  const searchHistory = useCallback(async (sessionId: string, keyword: string, maxResults?: number, previewLength?: number) => {
    const result = await getClient().sendCommand({ type: "search_history", sessionId, keyword, maxResults, previewLength });
    return result as { matches: { index: number; text: string; kind: string }[]; totalEntries: number };
  }, [getClient]);

  const actions = useMemo(
    () =>
      createAppActions(
        queueRef.current,
        (sessionId, requestId, response) => {
          void getClient()
            .respondExtensionUi(sessionId, requestId, response as never)
            .catch(() => undefined);
        },
      ),
    [getClient],
  );

  const answerDialog = useCallback(
    (requestId: string, value: string | string[]) => actions.answerDialog(requestId, value),
    [actions],
  );
  const cancelDialog = useCallback(
    (requestId: string) => actions.cancelDialog(requestId),
    [actions],
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
      openSession,
      openExistingSession,
      closeSession,
      listHostSessions,
      listLiveSessions,
      loadSessionHistory,
      loadMoreHistory,
      searchHistory,
      listModels,
      listSkills,
      getMaestroSettings,
      updateMaestroSettings,
      fetchSessionUsage,
      fetchMonitorState,
      setModel,
      setThinking,
      compactSession,
      renameSession,
      sendPrompt,
      sendSteer,
      sendSteerWindow,
      sendAbort,
      answerDialog,
      cancelDialog,
      lastError: state.lastError,
    }),
    [state, connectionState, hostUrl, token, connect, disconnect, openSession, openExistingSession, closeSession, listHostSessions, listLiveSessions, loadSessionHistory, loadMoreHistory, searchHistory, listModels, listSkills, getMaestroSettings, updateMaestroSettings, fetchSessionUsage, fetchMonitorState, setModel, setThinking, compactSession, renameSession, sendPrompt, sendSteer, sendSteerWindow, sendAbort, answerDialog, cancelDialog],
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

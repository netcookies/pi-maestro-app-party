/**
 * HostStore — 全局连接与状态管理（React Context）
 *
 * 职责：
 * - 持有 HostClient（WS 连接）
 * - 持有 AppState（事件流投影）
 * - 暴露 connect / disconnect / sendPrompt / answerDialog 等动作
 */
import React, { createContext, useContext, useMemo, useReducer, useRef, useState, useCallback } from "react";
import type { ExtensionUiRequest, HostEvent, HostSessionList, LiveSessionList } from "@maestro-mobile/shared";
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
  connect(url: string, token?: string): void;
  disconnect(): void;
  openSession(cwd: string): Promise<string>;
  openExistingSession(sessionFile: string, cwd: string): Promise<string>;
  listHostSessions(cwd?: string): Promise<HostSessionList>;
  listLiveSessions(): Promise<LiveSessionList>;
  loadSessionHistory(sessionId: string): Promise<void>;
  sendPrompt(sessionId: string, message: string): Promise<void>;
  sendSteer(sessionId: string, message: string): Promise<void>;
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

  const connect = useCallback((url: string, token?: string) => {
    clientRef.current?.close();
    setHostUrl(url);
    const client = new HostClient({
      url,
      token,
      reconnectBaseMs: 1000,
      reconnectMaxMs: 15000,
      onEvent: (event) => dispatch(event),
      onStateChange: (s) => setConnectionState(s),
    });
    clientRef.current = client;
    client.connect();
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    queueRef.current.clearAll();
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

  const listHostSessions = useCallback(async (cwd?: string): Promise<HostSessionList> => {
    const result = await getClient().sendCommand({ type: "list_host_sessions", cwd });
    return result as HostSessionList;
  }, [getClient]);

  const listLiveSessions = useCallback(async (): Promise<LiveSessionList> => {
    const result = await getClient().sendCommand({ type: "list_live_sessions" });
    return result as LiveSessionList;
  }, [getClient]);

  const sendPrompt = useCallback(async (sessionId: string, message: string) => {
    await getClient().sendCommand({ type: "prompt", sessionId, message });
  }, [getClient]);

  const sendSteer = useCallback(async (sessionId: string, message: string) => {
    await getClient().sendCommand({ type: "steer", sessionId, message });
  }, [getClient]);

  const sendAbort = useCallback(async (sessionId: string) => {
    await getClient().sendCommand({ type: "abort", sessionId });
  }, [getClient]);

  const loadSessionHistory = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const snapshot = await getClient().getSnapshot(sessionId);
      dispatch({ type: "__history_load", sessionId, items: snapshot.timeline, seq: snapshot.nextSeq } as never);
    } catch {
      // snapshot 失败静默（历史不可见但不阻塞）
    }
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
      connect,
      disconnect,
      openSession,
      openExistingSession,
      listHostSessions,
      listLiveSessions,
      loadSessionHistory,
      sendPrompt,
      sendSteer,
      sendAbort,
      answerDialog,
      cancelDialog,
      lastError: state.lastError,
    }),
    [state, connectionState, hostUrl, connect, disconnect, openSession, openExistingSession, listHostSessions, listLiveSessions, loadSessionHistory, sendPrompt, sendSteer, sendAbort, answerDialog, cancelDialog],
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

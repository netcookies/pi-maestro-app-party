/**
 * mobile-agent 接口类型 — 定义 host 需要的 Pi SDK 会话最小接口
 * 通过鸭类型兼容 @earendil-works/pi-coding-agent 的 AgentSession
 */
import type {
  ExtensionUIContext,
  AgentSessionEvent,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";

export interface MobileAgentSession {
  sessionId: string;
  sessionName?: string;
  sessionFile?: string;
  messages: unknown[];
  pendingMessageCount: number;
  isStreaming: boolean;
  isCompacting: boolean;
  model?: unknown;
  thinkingLevel?: string;

  prompt(
    message: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      source?: "rpc" | "extension";
      preflightResult?: (success: boolean) => void;
    },
  ): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  followUp(message: string): Promise<unknown>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  bindExtensions(options: {
    mode?: "tui" | "rpc";
    uiContext?: ExtensionUIContext;
    commandContextActions?: Record<string, unknown>;
    shutdownHandler?: () => void;
    onError?: (error: { event: string; error: string }) => void;
  }): Promise<void>;
}

export interface MobileAgentRuntime {
  session: MobileAgentSession;
  cwd: string;
  dispose(): Promise<void>;
  newSession?(options: unknown): Promise<unknown>;
  switchSession?(sessionPath: string, options: unknown): Promise<unknown>;
}

export interface RuntimeFactory {
  createRuntime(request: { cwd: string; mode?: "create" | "continue"; sessionFile?: string }): Promise<MobileAgentRuntime>;
  listSessions(cwd?: string): Promise<SessionInfo[]>;
}

export type { SessionInfo };
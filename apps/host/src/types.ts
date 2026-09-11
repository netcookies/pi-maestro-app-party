import type { SessionState, SessionSnapshot, HostEvent, TimelineItem } from "@maestro-mobile/shared";
import type { MobileAgentRuntime, MobileAgentSession } from "./mobile-agent.js";

export type HostEventListener = (event: HostEvent) => void;

export interface OpenSessionRequest {
  cwd: string;
  mode?: "create" | "continue";
  sessionFile?: string;
}

export interface SessionRunner {
  readonly id: string;
  readonly state: SessionState;
  readonly hasMoreHistory: boolean;
  snapshot(): SessionSnapshot;
  eventsSince(seq: number): HostEvent[];
  loadMoreHistory(count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }>;
  searchHistory(keyword: string, maxResults?: number, previewLength?: number): Promise<{ matches: { index: number; text: string; kind: string }[]; totalEntries: number }>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp", images?: unknown[]): Promise<void>;
  recordUserMessage?(message: string, images?: unknown[]): void;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  /** SDK 实时上下文用量（不可用时返回 null） */
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | null;
  /** 会话 token 用量（JSONL 聚合） */
  getUsage?(): Promise<{ entries: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; totalTokens: number; cost: number }>;
  listModels?(): { id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[];
  listLoadedSkills?(): { name: string; description?: string }[];
  setModel?(modelId: string): Promise<{ ok: boolean; error?: string }>;
  setThinking?(level: string): { ok: boolean; error?: string };
  compact?(customInstructions?: string): Promise<{ ok: boolean; error?: string }>;
  renameSession?(name: string): { ok: boolean; error?: string };
  respondToExtensionUi(requestId: string, response: unknown): boolean;
  dispose(): Promise<void>;
}

export interface RuntimeFactory {
  createRuntime(request: OpenSessionRequest): Promise<MobileAgentRuntime>;
  listSessions(cwd?: string): Promise<unknown[]>;
}

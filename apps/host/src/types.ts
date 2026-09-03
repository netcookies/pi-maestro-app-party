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
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  respondToExtensionUi(requestId: string, response: unknown): boolean;
  dispose(): Promise<void>;
}

export interface RuntimeFactory {
  createRuntime(request: OpenSessionRequest): Promise<MobileAgentRuntime>;
  listSessions(cwd?: string): Promise<unknown[]>;
}

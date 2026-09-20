import type { MonitorReadSnapshot } from "./monitor-read-service.js";
import type { MonitorQueryService } from "./monitor-query-service.js";
import type { SessionCommand, CommandResult, SessionCommandService } from "./session-command-service.js";
import type { SessionListOptions, QueryResult, SessionQueryService } from "./session-query-service.js";
import type { SessionSnapshot, HostSessionList, TimelineItem, ExtensionUiResponse } from "@maestro-mobile/shared";
import type { SessionTargetIdentity } from "../control/SessionDirectory.js";
import type { UsageTotals } from "../usage-reader.js";
import type { OpenSessionRequest } from "../types.js";

export interface ApplicationLifecycle {
  openSession(request: OpenSessionRequest): Promise<{ id: string }>;
  closeSession(sessionId: string, target?: SessionTargetIdentity): Promise<boolean>;
  respondToExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse, target?: SessionTargetIdentity): Promise<boolean>;
  sessionOperation?(operation: SessionOperation): Promise<unknown>;
  readMaestroState?(): Promise<unknown>;
  readSettings?(): Promise<unknown>;
  updateSettings?(patch: Record<string, unknown>): Promise<unknown>;
}

export type SessionOperation =
  | { kind: "load_more_history"; target: SessionTargetIdentity; count?: number }
  | { kind: "search_history"; target: SessionTargetIdentity; keyword: string; maxResults: number; previewLength: number }
  | { kind: "list_models"; target: SessionTargetIdentity }
  | { kind: "list_skills"; target: SessionTargetIdentity }
  | { kind: "set_model"; target: SessionTargetIdentity; modelId: string; provider?: string }
  | { kind: "compact"; target: SessionTargetIdentity; customInstructions?: string }
  | { kind: "rename_session"; target: SessionTargetIdentity; name: string };


export type ApplicationQuery =
  | { kind: "session_list"; options?: SessionListOptions }
  | { kind: "session_snapshot"; target: SessionTargetIdentity }
  | { kind: "session_history"; target: SessionTargetIdentity; count?: number }
  | { kind: "session_usage"; target: SessionTargetIdentity }
  | { kind: "monitor" };
export type ApplicationQueryResult =
  | HostSessionList
  | QueryResult<SessionSnapshot>
  | QueryResult<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number; historyAvailable?: boolean }>
  | QueryResult<UsageTotals>
  | MonitorReadSnapshot;

export class ApplicationCommandRouter {
  constructor(
    private readonly commands: SessionCommandService,
    private readonly sessions: SessionQueryService,
    private readonly monitor: MonitorQueryService,
    private readonly lifecycle?: ApplicationLifecycle,
  ) {}

  command(command: SessionCommand): Promise<CommandResult> {
    return this.commands.execute(command);
  }

  query(query: ApplicationQuery): Promise<ApplicationQueryResult> {
    switch (query.kind) {
      case "session_list": return this.sessions.list(query.options);
      case "session_snapshot": return this.sessions.snapshot(query.target);
      case "session_history": return this.sessions.history(query.target, query.count);
      case "session_usage": return this.sessions.usage(query.target);
      case "monitor": return this.monitor.read();
    }
  }

  openSession(request: OpenSessionRequest): Promise<{ id: string }> {
    if (!this.lifecycle) return Promise.reject(new Error("session lifecycle unavailable"));
    return this.lifecycle.openSession(request);
  }

  closeSession(sessionId: string, target?: SessionTargetIdentity): Promise<boolean> {
    if (!this.lifecycle) return Promise.reject(new Error("session lifecycle unavailable"));
    return this.lifecycle.closeSession(sessionId, target);
  }

  respondToExtensionUi(sessionId: string, requestId: string, response: ExtensionUiResponse, target?: SessionTargetIdentity): Promise<boolean> {
    return this.lifecycle?.respondToExtensionUi(sessionId, requestId, response, target) ?? Promise.resolve(false);
  }

  sessionOperation(operation: SessionOperation): Promise<unknown> {
    if (!this.lifecycle?.sessionOperation) return Promise.reject(new Error("session operation unavailable"));
    return this.lifecycle.sessionOperation(operation);
  }

  readMaestroState(): Promise<unknown> {
    if (!this.lifecycle?.readMaestroState) return Promise.reject(new Error("maestro state unavailable"));
    return this.lifecycle.readMaestroState();
  }

  readSettings(): Promise<unknown> {
    if (!this.lifecycle?.readSettings) return Promise.reject(new Error("settings unavailable"));
    return this.lifecycle.readSettings();
  }

  updateSettings(patch: Record<string, unknown>): Promise<unknown> {
    if (!this.lifecycle?.updateSettings) return Promise.reject(new Error("settings unavailable"));
    return this.lifecycle.updateSettings(patch);
  }
}

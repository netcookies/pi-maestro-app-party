import { normalize } from "node:path";
import type { HostSessionList, HostSessionSummary, MonitorState, OperationStatus, SessionPresentation, SessionRuntimeStatus, SessionSnapshot, TimelineItem } from "@maestro-mobile/shared";
import type { SessionDirectory, SessionDirectoryTarget, SessionTargetIdentity } from "../control/SessionDirectory.js";
import type { UsageTotals } from "../usage-reader.js";

export interface SessionListSource {
  listSessions(cwd?: string): Promise<unknown[]>;
}

export interface SessionListOptions {
  cwd?: string;
  projectCwds?: string[];
  query?: string;
  limit?: number;
  cursor?: string;
  includeMonitor?: boolean;
}

export interface QueryResult<T> {
  ok: boolean;
  value?: T;
  status?: Extract<OperationStatus, "unknown" | "failed">;
  error?: { code: string; message?: string };
  revision: number;
}

function asIso(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function summaryOf(record: Record<string, unknown>): HostSessionSummary {
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const title = String(record.firstMessage ?? record.title ?? "");
  return {
    id: String(record.id ?? ""),
    sessionId: String(record.id ?? ""),
    endpointId: "history",
    runtimeStatus: "history",
    cwd,
    cwdName: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
    path: String(record.path ?? record.sessionFile ?? ""),
    title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
    ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    messageCount: typeof record.messageCount === "number" ? record.messageCount : 0,
    updatedAt: asIso(record.modified ?? record.updatedAt),
    ...(record.created || record.createdAt ? { createdAt: asIso(record.created ?? record.createdAt) } : {}),
  };
}

function cursorFor(session: HostSessionSummary): string {
  return Buffer.from(JSON.stringify({ updatedAt: session.updatedAt, id: session.id }), "utf8").toString("base64url");
}

function readCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt?: unknown; id?: unknown };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error("invalid cursor");
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new Error("invalid cursor");
  }
}

function readonlyPresentation(revision: number): SessionPresentation {
  return {
    role: "session",
    visibility: "session_list",
    control: {
      mode: "readonly",
      canPrompt: false,
      canSteer: false,
      canFollowUp: false,
      canAbort: false,
      canAnswerAsk: false,
    },
    revision,
  };
}

function runtimeStatusForTarget(target: SessionDirectoryTarget): SessionRuntimeStatus {
  const runState = target.runner?.state.runState;
  if (!runState) return "history";
  return runState === "idle" || runState === "error" ? "idle" : "running";
}

export class SessionQueryService {
  constructor(
    private readonly source: SessionListSource,
    private readonly directory: SessionDirectory,
    private readonly presentationFor?: (sessionId: string) => SessionPresentation | undefined,
    private readonly now: () => number = Date.now,
    private readonly monitorState?: () => Promise<MonitorState>,
    private readonly targetFor?: (sessionId: string) => SessionDirectoryTarget | undefined,
  ) {}

  async list(options: SessionListOptions = {}): Promise<HostSessionList> {
    if (options.cursor && options.limit === undefined) throw new Error("cursor requires limit");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
      throw new Error("limit must be between 1 and 100");
    }
    const projectCwds = options.projectCwds?.map((cwd) => normalize(cwd.trim())).filter(Boolean);
    const query = options.query?.trim().toLocaleLowerCase();
    const records = await this.source.listSessions(options.cwd);
    const monitorWindows = this.monitorState ? (await this.monitorState()).windows : [];
    const windowsBySessionId = new Map<string, typeof monitorWindows>();
    for (const window of monitorWindows) {
      const windows = windowsBySessionId.get(window.sessionId) ?? [];
      windows.push(window);
      windowsBySessionId.set(window.sessionId, windows);
    }
    const summaries = records.map((record) => summaryOf(record as Record<string, unknown>));
    const knownSessionIds = new Set(summaries.map((session) => session.sessionId));
    for (const window of monitorWindows) {
      if (knownSessionIds.has(window.sessionId)) continue;
      const cwd = window.cwd ?? "";
      summaries.push({
        id: window.sessionId,
        sessionId: window.sessionId,
        endpointId: window.endpointId,
        runtimeStatus: window.runtimeStatus,
        cwd,
        cwdName: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
        path: "",
        title: window.name ?? window.sessionId,
        messageCount: 0,
        updatedAt: new Date(this.now()).toISOString(),
        presentation: window.presentation,
      });
    }
    let sessions = summaries.map((summary) => {
      const target = this.targetFor?.(summary.sessionId);
      if (target) {
        const cwd = target.identity.normalizedCwd;
        return {
          ...summary,
          endpointId: target.identity.endpointId,
          runtimeStatus: runtimeStatusForTarget(target),
          cwd,
          cwdName: cwd.split("/").filter(Boolean).at(-1) ?? cwd,
          presentation: target.presentation ?? readonlyPresentation(this.directory.revision),
        };
      }
      const hasDirectoryTargets = this.directory.list().some((candidate) => candidate.identity.sessionId === summary.sessionId);
      if (hasDirectoryTargets) return summary;
      const windows = windowsBySessionId.get(summary.sessionId) ?? [];
      const window = windows.length === 1 ? windows[0] : undefined;
      const directoryPresentation = this.presentationFor?.(summary.sessionId);
      return window
        ? {
            ...summary,
            endpointId: window.endpointId,
            runtimeStatus: window.runtimeStatus,
            ...(directoryPresentation ?? window.presentation ?? summary.presentation
              ? { presentation: directoryPresentation ?? window.presentation ?? summary.presentation }
              : {}),
          }
        : summary;
    }).filter((session) => {
      const presentation = session.presentation ?? this.presentationFor?.(session.id) ?? readonlyPresentation(this.directory.revision);
      if (!options.includeMonitor && presentation.visibility === "monitor_tab") return false;
      if (projectCwds && !projectCwds.includes(session.cwd)) return false;
      if (!query) return true;
      return [session.id, session.cwd, session.title, session.name, session.model]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const total = sessions.length;
    let start = 0;
    if (options.cursor) {
      const cursor = readCursor(options.cursor);
      start = sessions.findIndex((session) => session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.id < cursor.id));
      if (start < 0) start = sessions.length;
    }
    if (options.limit !== undefined) {
      sessions = sessions.slice(start, start + options.limit);
      const last = sessions.at(-1);
      return {
        sessions: sessions.map((session) => this.withPresentation(session)),
        observedAt: new Date(this.now()).toISOString(),
        hasMore: start + sessions.length < total,
        total,
        ...(start + sessions.length < total && last ? { nextCursor: cursorFor(last) } : {}),
      };
    }
    return { sessions: sessions.map((session) => this.withPresentation(session)), observedAt: new Date(this.now()).toISOString() };
  }

  async snapshot(target: SessionTargetIdentity): Promise<QueryResult<SessionSnapshot>> {
    const entry = this.directory.resolve(target);
    if (!entry) return { ok: false, status: "unknown", error: { code: "target_unavailable" }, revision: this.directory.revision };
    if (!entry.runner) return { ok: false, status: "failed", error: { code: "session_readonly_or_unavailable" }, revision: this.directory.revision };
    const snapshot = entry.runner.snapshot();
    return {
      ok: true,
      value: {
        ...snapshot,
        session: {
          ...snapshot.session,
          presentation: entry.presentation ?? readonlyPresentation(this.directory.revision),
        },
      },
      revision: this.directory.revision,
    };
  }

  async history(target: SessionTargetIdentity, count?: number): Promise<QueryResult<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }>> {
    const entry = this.directory.resolve(target);
    if (!entry) return { ok: false, status: "unknown", error: { code: "target_unavailable" }, revision: this.directory.revision };
    if (!entry.runner) return { ok: false, status: "failed", error: { code: "session_readonly_or_unavailable" }, revision: this.directory.revision };
    return { ok: true, value: await entry.runner.loadMoreHistory(count), revision: this.directory.revision };
  }

  async usage(target: SessionTargetIdentity): Promise<QueryResult<UsageTotals>> {
    const entry = this.directory.resolve(target);
    if (!entry) return { ok: false, status: "unknown", error: { code: "target_unavailable" }, revision: this.directory.revision };
    if (!entry.runner) return { ok: false, status: "failed", error: { code: "session_readonly_or_unavailable" }, revision: this.directory.revision };
    if (!entry.runner.getUsage) return { ok: false, status: "failed", error: { code: "usage_unavailable" }, revision: this.directory.revision };
    return { ok: true, value: await entry.runner.getUsage(), revision: this.directory.revision };
  }

  private withPresentation(session: HostSessionSummary): HostSessionSummary {
    return {
      ...session,
      presentation: session.presentation ?? this.presentationFor?.(session.id) ?? readonlyPresentation(this.directory.revision),
    };
  }
}

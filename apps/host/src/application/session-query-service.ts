import { normalize } from "node:path";
import type { HostSessionList, HostSessionSummary, JsonValue, MonitorState, OperationStatus, SessionPresentation, SessionRuntimeStatus, SessionSnapshot, TimelineItem } from "@maestro-mobile/shared";
import type { SessionDirectory, SessionDirectoryTarget, SessionTargetIdentity } from "../control/SessionDirectory.js";
import type { UsageTotals } from "../usage-reader.js";
import { replayPageBeforeJsonl, replayTailFromJsonl } from "../jsonl-pager.js";

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
  sessionIds?: string[];
  latestForCwds?: string[];
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

function targetIdentityKey(identity: SessionTargetIdentity): string {
  return JSON.stringify([identity.sessionId, identity.endpointId, identity.normalizedCwd, identity.processGeneration]);
}

function listKey(session: HostSessionSummary): string {
  return session.targetKey ?? session.id;
}

function cursorFor(session: HostSessionSummary): string {
  return Buffer.from(JSON.stringify({ updatedAt: session.updatedAt, id: listKey(session) }), "utf8").toString("base64url");
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

/** 已注册的 Desktop socket 即使尚未附着 Host reader，也属于活跃目标。 */
function runtimeStatusForTarget(target: SessionDirectoryTarget): SessionRuntimeStatus {
  if (target.kind === "desktop") return target.runtimeStatus ?? "idle";
  const runState = target.runner?.state.runState;
  if (!runState) return "history";
  return runState === "idle" || runState === "error" ? "idle" : "running";
}

function presentationForTarget(
  target: SessionDirectoryTarget,
  revision: number,
  sourcePresentation?: SessionPresentation,
): SessionPresentation {
  const targetPresentation = target.presentation ?? readonlyPresentation(revision);
  if (!sourcePresentation) return targetPresentation;
  return {
    ...targetPresentation,
    ...sourcePresentation,
    control: targetPresentation.control,
    revision: Math.max(targetPresentation.revision, sourcePresentation.revision),
  };
}

function summaryForTarget(
  target: SessionDirectoryTarget,
  revision: number,
  observedAt: string,
  base?: HostSessionSummary,
  sourcePresentation?: SessionPresentation,
): HostSessionSummary {
  const cwd = target.identity.normalizedCwd;
  const cwdName = cwd.split("/").filter(Boolean).at(-1) ?? cwd;
  const runnerState = target.runner?.state;
  return {
    ...base,
    id: target.identity.sessionId,
    sessionId: target.identity.sessionId,
    endpointId: target.identity.endpointId,
    target: { ...target.identity },
    targetKey: targetIdentityKey(target.identity),
    runtimeStatus: runtimeStatusForTarget(target),
    cwd,
    cwdName,
    path: target.sessionFile ?? base?.path ?? runnerState?.sessionFile ?? "",
    title: base?.title || runnerState?.title || cwdName || target.identity.sessionId,
    messageCount: target.messageCount ?? runnerState?.messageCount ?? base?.messageCount ?? 0,
    updatedAt: target.lastActivityAt ?? runnerState?.updatedAt ?? base?.updatedAt ?? observedAt,
    presentation: presentationForTarget(target, revision, sourcePresentation),
    ...(target.activeSince ? { activeSince: target.activeSince } : {}),
    ...(target.lastActivityAt ? { lastActivityAt: target.lastActivityAt } : {}),
    ...(target.summaryRevision !== undefined ? { summaryRevision: target.summaryRevision } : {}),
    ...(target.usage ? { usage: target.usage, totalTokens: target.usage.totalTokens, cost: target.usage.cost } : {}),
    ...(target.context !== undefined ? { context: target.context } : {}),
  };
}

export class SessionQueryService {
  private readonly desktopHistory = new Map<string, { cursor: number; totalEntries: number }>();

  constructor(
    private readonly source: SessionListSource,
    private readonly directory: SessionDirectory,
    private readonly presentationFor?: (sessionId: string) => SessionPresentation | undefined,
    private readonly now: () => number = Date.now,
    private readonly monitorState?: () => Promise<MonitorState>,
    private readonly targetFor?: (sessionId: string) => SessionDirectoryTarget | undefined,
  ) {}

  async list(options: SessionListOptions = {}): Promise<HostSessionList> {
    const targeted = options.sessionIds !== undefined || options.latestForCwds !== undefined;
    for (const values of [options.sessionIds, options.latestForCwds]) {
      if (values && values.length > 100) throw new Error("targeted filters accept at most 100 values");
      if (values?.some((value) => typeof value !== "string" || value.length === 0)) throw new Error("targeted filters require non-empty strings");
    }
    if (targeted && (options.limit !== undefined || options.cursor !== undefined || options.query !== undefined || options.cwd !== undefined)) {
      throw new Error("targeted session lookup cannot be combined with paging or search filters");
    }
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
    const observedAt = new Date(this.now()).toISOString();
    const directoryTargets = this.directory.list();
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
        updatedAt: observedAt,
        presentation: window.presentation,
      });
    }
    const projectedTargetKeys = new Set<string>();
    let sessions = summaries.flatMap((summary) => {
      const windows = windowsBySessionId.get(summary.sessionId) ?? [];
      const window = windows.length === 1 ? windows[0] : undefined;
      const sourcePresentation = window?.presentation ?? summary.presentation ?? this.presentationFor?.(summary.sessionId);
      const matchingTargets = directoryTargets.filter((candidate) => candidate.identity.sessionId === summary.sessionId);
      if (matchingTargets.length > 0) {
        return matchingTargets.flatMap((target) => {
          const targetKey = targetIdentityKey(target.identity);
          if (projectedTargetKeys.has(targetKey)) return [];
          projectedTargetKeys.add(targetKey);
          const attributedWindows = windows.filter((candidate) => candidate.endpointId === target.identity.endpointId
            && candidate.cwd !== undefined && normalize(candidate.cwd) === target.identity.normalizedCwd);
          const sameEndpointTargets = matchingTargets.filter((candidate) => candidate.identity.endpointId === target.identity.endpointId
            && candidate.identity.normalizedCwd === target.identity.normalizedCwd);
          const presentation = matchingTargets.length === 1 ? sourcePresentation
            : attributedWindows.length === 1 && sameEndpointTargets.length === 1 ? attributedWindows[0].presentation : undefined;
          return [summaryForTarget(target, this.directory.revision, observedAt, summary, presentation)];
        });
      }
      const target = this.targetFor?.(summary.sessionId);
      if (target) {
        projectedTargetKeys.add(targetIdentityKey(target.identity));
        return [summaryForTarget(target, this.directory.revision, observedAt, summary, sourcePresentation)];
      }
      const directoryPresentation = this.presentationFor?.(summary.sessionId);
      return [window
        ? {
            ...summary,
            endpointId: window.endpointId,
            runtimeStatus: window.runtimeStatus,
            ...(directoryPresentation ?? window.presentation ?? summary.presentation
              ? { presentation: directoryPresentation ?? window.presentation ?? summary.presentation }
              : {}),
          }
        : summary];
    });
    for (const target of directoryTargets) {
      const targetKey = targetIdentityKey(target.identity);
      if (projectedTargetKeys.has(targetKey)) continue;
      sessions.push(summaryForTarget(target, this.directory.revision, observedAt));
    }
    sessions = sessions.filter((session) => {
      const presentation = session.presentation ?? this.presentationFor?.(session.id) ?? readonlyPresentation(this.directory.revision);
      if (!options.includeMonitor && presentation.visibility === "monitor_tab") return false;
      if (projectCwds && !projectCwds.includes(session.cwd)) return false;
      if (!query) return true;
      return [session.id, session.cwd, session.title, session.name, session.model]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || listKey(b).localeCompare(listKey(a)));
    if (targeted) {
      const selectedSessionIds = new Set(options.sessionIds ?? []);
      const latestForCwds = new Set(options.latestForCwds ?? []);
      const selectedCwds = new Set<string>();
      if (latestForCwds.size > 0) {
        for (const session of sessions) {
          if (latestForCwds.has(session.cwd) && !selectedCwds.has(session.cwd)) {
            selectedCwds.add(session.cwd);
            selectedSessionIds.add(session.sessionId);
          }
        }
      }
      return {
        sessions: sessions.filter((session) => selectedSessionIds.has(session.sessionId)).map((session) => this.withPresentation(session)),
        observedAt,
        targeted: true,
      };
    }
    const total = sessions.length;
    let start = 0;
    if (options.cursor) {
      const cursor = readCursor(options.cursor);
      start = sessions.findIndex((session) => session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && listKey(session) < cursor.id));
      if (start < 0) start = sessions.length;
    }
    if (options.limit !== undefined) {
      sessions = sessions.slice(start, start + options.limit);
      const last = sessions.at(-1);
      return {
        sessions: sessions.map((session) => this.withPresentation(session)),
        observedAt,
        hasMore: start + sessions.length < total,
        total,
        ...(start + sessions.length < total && last ? { nextCursor: cursorFor(last) } : {}),
      };
    }
    return { sessions: sessions.map((session) => this.withPresentation(session)), observedAt };
  }

  async snapshot(target: SessionTargetIdentity): Promise<QueryResult<SessionSnapshot>> {
    const entry = this.directory.resolve(target);
    if (!entry) return { ok: false, status: "unknown", error: { code: "target_unavailable" }, revision: this.directory.revision };
    if (!entry.runner) {
      if (entry.kind !== "desktop") return { ok: false, status: "failed", error: { code: "session_readonly_or_unavailable" }, revision: this.directory.revision };
      const runtimeStatus = runtimeStatusForTarget(entry);
      const updatedAt = entry.lastActivityAt ?? new Date(this.now()).toISOString();
      let timeline: TimelineItem[] = [];
      let hasMoreHistory = false;
      if (entry.sessionFile) {
        const page = await replayTailFromJsonl(entry.sessionFile, 80);
        timeline = page.items;
        hasMoreHistory = page.hasMore;
        this.desktopHistory.set(targetIdentityKey(entry.identity), { cursor: page.cursor, totalEntries: page.totalEntries });
      }
      return {
        ok: true,
        value: {
          session: {
            id: entry.identity.sessionId,
            cwd: entry.identity.normalizedCwd,
            title: entry.identity.normalizedCwd.split("/").filter(Boolean).at(-1) ?? entry.identity.sessionId,
            runState: runtimeStatus === "running" ? "streaming" : "idle",
            messageCount: entry.messageCount ?? 0,
            pendingMessageCount: 0,
            updatedAt,
            ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
            ...(entry.model ? { model: structuredClone(entry.model) as unknown as JsonValue } : {}),
            ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
            presentation: entry.presentation ?? readonlyPresentation(this.directory.revision),
          },
          timeline,
          nextSeq: 0,
          historyAvailable: Boolean(entry.sessionFile),
          hasMoreHistory,
        },
        revision: this.directory.revision,
      };
    }
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

  async history(target: SessionTargetIdentity, count?: number): Promise<QueryResult<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number; historyAvailable?: boolean }>> {
    const entry = this.directory.resolve(target);
    if (!entry) return { ok: false, status: "unknown", error: { code: "target_unavailable" }, revision: this.directory.revision };
    if (!entry.runner) {
      if (entry.kind === "desktop" && entry.sessionFile) {
        const key = targetIdentityKey(entry.identity);
        const cursor = this.desktopHistory.get(key)?.cursor ?? (await replayTailFromJsonl(entry.sessionFile, 80)).cursor;
        const page = await replayPageBeforeJsonl(entry.sessionFile, cursor, count ?? 100);
        this.desktopHistory.set(key, { cursor: page.cursor, totalEntries: page.totalEntries });
        return { ok: true, value: { items: page.items, hasMore: page.hasMore, totalEntries: page.totalEntries, historyAvailable: true }, revision: this.directory.revision };
      }
      if (entry.kind === "desktop") return { ok: true, value: { items: [], hasMore: false, totalEntries: 0, historyAvailable: false }, revision: this.directory.revision };
      return { ok: false, status: "failed", error: { code: "session_readonly_or_unavailable" }, revision: this.directory.revision };
    }
    return { ok: true, value: await entry.runner.loadMoreHistory(count), revision: this.directory.revision };
  }

  async usage(target: SessionTargetIdentity): Promise<QueryResult<UsageTotals>> {
    const entry = this.directory.resolve(target);
    if (!entry) return { ok: false, status: "unknown", error: { code: "target_unavailable" }, revision: this.directory.revision };
    if (!entry.runner) {
      if (entry.kind === "desktop") {
        const usage = entry.usage;
        return {
          ok: true,
          value: {
            entries: 0,
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            cacheRead: usage?.cacheRead ?? 0,
            cacheWrite: usage?.cacheWrite ?? 0,
            reasoning: 0,
            totalTokens: usage?.totalTokens ?? 0,
            cost: usage?.cost ?? 0,
          },
          revision: this.directory.revision,
        };
      }
      return { ok: false, status: "failed", error: { code: "session_readonly_or_unavailable" }, revision: this.directory.revision };
    }
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

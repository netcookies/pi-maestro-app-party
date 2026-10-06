import type { DesktopPlanRequest, DesktopPlanResponse, SessionTargetIdentity } from "@maestro-mobile/shared";
import { sessionTargetKey } from "@maestro-mobile/shared";

export type PlanEntryStatus = "pending" | "answered" | "cancelled" | "expired";
export interface PlanEntry {
  request: DesktopPlanRequest;
  sessionId: string;
  target: SessionTargetIdentity;
  receivedAt: number;
  status: PlanEntryStatus;
  editedMarkdown?: string;
}

export const MAX_QUEUED_PLANS = 32;

function keyOf(requestId: string, kind: DesktopPlanRequest["kind"], target: SessionTargetIdentity): string {
  return JSON.stringify([requestId, kind, sessionTargetKey(target)]);
}

export class PlanQueue {
  private readonly plans = new Map<string, PlanEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private pruneFinished(): void {
    for (const [key, entry] of this.plans) {
      if (this.plans.size <= MAX_QUEUED_PLANS || entry.status === "pending") continue;
      this.plans.delete(key);
    }
    while (this.plans.size > MAX_QUEUED_PLANS) {
      const oldest = this.plans.entries().next().value as [string, PlanEntry] | undefined;
      if (!oldest) return;
      const [key, entry] = oldest;
      if (entry.status === "pending") this.plans.set(key, { ...entry, status: "expired" });
      else this.plans.delete(key);
    }
  }

  get pendingPlans(): PlanEntry[] {
    return [...this.plans.values()].filter((entry) => entry.status === "pending");
  }

  get count(): number {
    return this.pendingPlans.length;
  }

  enqueue(sessionId: string, request: DesktopPlanRequest, target: SessionTargetIdentity): PlanEntry {
    const key = keyOf(request.requestId, request.kind, target);
    const existing = this.plans.get(key);
    if (existing) {
      if (request.revision <= existing.request.revision) return existing;
      this.plans.delete(key);
    }
    const entry: PlanEntry = {
      request,
      sessionId,
      target,
      receivedAt: existing?.receivedAt ?? this.now(),
      status: "pending",
      ...(existing?.editedMarkdown ? { editedMarkdown: existing.editedMarkdown } : {}),
    };
    this.plans.set(key, entry);
    this.pruneFinished();
    return entry;
  }

  get(requestId: string, kind: DesktopPlanRequest["kind"], target?: SessionTargetIdentity): PlanEntry | undefined {
    for (const entry of this.plans.values()) {
      if (entry.request.requestId !== requestId || entry.request.kind !== kind) continue;
      if (!target || sessionTargetKey(entry.target) === sessionTargetKey(target)) return entry;
    }
    return undefined;
  }

  answer(requestId: string, kind: DesktopPlanRequest["kind"], response: DesktopPlanResponse, target?: SessionTargetIdentity): PlanEntry | undefined {
    const entry = this.get(requestId, kind, target);
    if (!entry || entry.status !== "pending") return undefined;
    const key = keyOf(requestId, kind, entry.target);
    this.plans.set(key, {
      ...entry,
      status: response.status === "cancelled" ? "cancelled" : "answered",
      ...(response.status === "edited" ? { editedMarkdown: response.markdown } : {}),
    });
    return entry;
  }

  reopen(requestId: string, kind: DesktopPlanRequest["kind"], target?: SessionTargetIdentity): boolean {
    const entry = this.get(requestId, kind, target);
    if (!entry) return false;
    const key = keyOf(requestId, kind, entry.target);
    this.plans.set(key, { ...entry, status: "pending" });
    return true;
  }

  drop(requestId: string, kind: DesktopPlanRequest["kind"], target: SessionTargetIdentity): boolean {
    const key = keyOf(requestId, kind, target);
    return this.plans.delete(key);
  }

  dropAny(requestId: string, target: SessionTargetIdentity): boolean {
    let removed = false;
    for (const [key, entry] of this.plans) {
      if (entry.request.requestId === requestId && sessionTargetKey(entry.target) === sessionTargetKey(target)) {
        this.plans.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.plans) {
      if (entry.sessionId === sessionId) this.plans.delete(key);
    }
  }

  clearAll(): void {
    this.plans.clear();
  }
}

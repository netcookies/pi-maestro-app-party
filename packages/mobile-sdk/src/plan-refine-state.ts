/**
 * Platform-agnostic Review & Refine projection and recovery state machine.
 *
 * The SDK owns ordering and recovery so every client does not reimplement it:
 * - refine sequence is scoped to `(refineSessionId, operationId)`;
 * - duplicate frames (`sequence < expected`) are ignored;
 * - a gap (`sequence > expected`) requests a snapshot instead of guessing;
 * - a snapshot replaces the whole projection and re-bases `expected`.
 *
 * Flow remains the business authority; this module never invents a terminal.
 */

import type {
  MobilePlanRefineActionResult,
  MobilePlanRefineEvent,
  MobilePlanRefineSnapshot,
  MobilePlanRefineTerminal,
  MobilePlanRefineTerminalStatus,
  MobilePlanRefineTurn,
  MobilePlanRefineUpdate,
} from "./mobile-plan-refine-protocol.js";
import { isMobilePlanRefineEvent } from "./mobile-plan-refine-protocol.js";

export type PlanRefineState =
  | { kind: "idle" }
  | {
      kind: "live";
      snapshot: MobilePlanRefineSnapshot;
      turns: MobilePlanRefineTurn[];
      expectedSequence: number;
      /** Set once a terminal frame arrives; no further state change is allowed. */
      terminal?: MobilePlanRefineTerminalStatus;
      actionResults: Map<string, MobilePlanRefineActionResult>;
    };

export interface PlanRefineStateListener {
  (state: PlanRefineState): void;
}

/**
 * Tracks one refine session projection. Create a new tracker per session; a
 * different `refineSessionId`/`operationId` is a different sequence scope.
 */
export class PlanRefineTracker {
  private state: PlanRefineState = { kind: "idle" };
  private readonly listeners = new Set<PlanRefineStateListener>();
  private snapshotRequests = 0;

  constructor(private readonly options: {
    /** Called when a gap is detected and a snapshot must be re-requested. */
    requestSnapshot?: (reason: "gap" | "unknown") => void;
  } = {}) {}

  get current(): PlanRefineState {
    return this.state;
  }

  /** Number of snapshot re-requests issued because of a gap or unknown frame. */
  get snapshotRequestCount(): number {
    return this.snapshotRequests;
  }

  subscribe(listener: PlanRefineStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.emit({ kind: "idle" });
  }

  /**
   * Apply one Host event. Returns how it was handled so callers (and tests) can
   * assert duplicate/gap/terminal behavior without inspecting internals.
   */
  apply(event: unknown): "applied" | "duplicate" | "gap" | "ignored" | "terminal" {
    if (!isMobilePlanRefineEvent(event)) return "ignored";
    const refined = event as MobilePlanRefineEvent;

    if (refined.type === "plan_refine_snapshot") {
      return this.applySnapshot(refined);
    }

    const live = this.state;
    if (live.kind !== "live") {
      // Without a baseline snapshot the client cannot order this frame.
      this.requestSnapshot("unknown");
      return "gap";
    }
    if (refined.refineSessionId !== live.snapshot.refineSessionId
      || refined.operationId !== live.snapshot.operationId) {
      return "ignored";
    }
    if (live.terminal !== undefined) return "terminal";
    if (refined.sequence < live.expectedSequence) return "duplicate";
    if (refined.sequence > live.expectedSequence) {
      this.requestSnapshot("gap");
      return "gap";
    }

    if (refined.type === "plan_refine_action_result") {
      const actionResults = new Map(live.actionResults);
      actionResults.set(refined.actionId, refined);
      this.emit({ ...live, actionResults, expectedSequence: refined.sequence + 1 });
      return "applied";
    }

    if (refined.type === "plan_refine_terminal") {
      this.emit({
        ...live,
        snapshot: { ...live.snapshot, status: refined.status },
        expectedSequence: refined.sequence + 1,
        terminal: refined.status,
      });
      return "applied";
    }

    const update = refined as MobilePlanRefineUpdate;
    const turns = update.turn
      ? upsertTurn(live.turns, update.turn)
      : live.turns;
    this.emit({
      ...live,
      snapshot: {
        ...live.snapshot,
        status: update.status,
        revision: update.revision,
      },
      turns,
      expectedSequence: update.sequence + 1,
    });
    return "applied";
  }

  private applySnapshot(snapshot: MobilePlanRefineSnapshot): "applied" | "ignored" | "terminal" | "duplicate" {
    const live = this.state;
    if (live.kind === "live") {
      if (live.snapshot.refineSessionId !== snapshot.refineSessionId
        || live.snapshot.operationId !== snapshot.operationId) {
        return "ignored";
      }
      if (live.terminal !== undefined) return "terminal";
      // A stale snapshot must not roll the projection backwards.
      if (snapshot.highWaterSequence < live.expectedSequence - 1) return "duplicate";
    }
    this.emit({
      kind: "live",
      snapshot,
      turns: [...snapshot.turns],
      expectedSequence: snapshot.highWaterSequence + 1,
      actionResults: new Map(),
      ...(isTerminal(snapshot.status) ? { terminal: snapshot.status } : {}),
    });
    return "applied";
  }

  private requestSnapshot(reason: "gap" | "unknown"): void {
    this.snapshotRequests += 1;
    this.options.requestSnapshot?.(reason);
  }

  private emit(state: PlanRefineState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function isTerminal(status: string): status is MobilePlanRefineTerminalStatus {
  return status === "applied" || status === "discarded" || status === "cancelled"
    || status === "failed" || status === "revision_conflict" || status === "disconnected";
}

function upsertTurn(turns: MobilePlanRefineTurn[], next: MobilePlanRefineTurn): MobilePlanRefineTurn[] {
  const index = turns.findIndex((turn) => turn.turnId === next.turnId);
  if (index < 0) return [...turns, next];
  const copy = [...turns];
  copy[index] = next;
  return copy;
}

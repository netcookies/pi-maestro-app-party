/**
 * Host adapter for the Flow Review & Refine transport.
 *
 * Two protocol owners meet here:
 * - Flow owns the refine business contract (`pi-maestro-flow/refine-transport`).
 * - Shared owns the Desktop Plugin/Broker wire frames.
 * - Mobile SDK owns the Host/Mobile frames.
 *
 * This module only translates Flow presentation state into the Shared wire and
 * relays user intent back into Flow. It never decides whether a refine run
 * succeeded or whether an Apply committed — Flow emits the terminal.
 */

import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type {
  DesktopPlanRefineAction,
  DesktopPlanRefineActionPayload,
  DesktopPlanRefineSnapshot,
  DesktopPlanRefineTurn,
  DesktopPlanRefineUpdate,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import { DESKTOP_PLAN_REFINE_FEATURE } from "@maestro-mobile/shared";

/** Structural mirror of the Flow contract; keeps Host free of a Flow dependency. */
export type FlowRefineRole = "reviewer" | "decomposer" | "optimizer" | "brainstormer";

export interface FlowRefineTransportTurn {
  readonly turnId: string;
  readonly role: FlowRefineRole;
  readonly modelLabel: string;
  readonly userInput: string;
  readonly output: string;
  readonly createdAt: string;
  readonly appliesAs: "feedback" | "draft";
}

export interface FlowRefineTransportSnapshot {
  readonly refineSessionId: string;
  readonly operationId: number;
  readonly target: {
    readonly sessionId: string;
    readonly endpointId?: string;
    readonly normalizedCwd: string;
    readonly processGeneration?: number;
  };
  readonly revision: number;
  readonly status: "opening" | "ready" | "running";
  readonly highWaterSequence: number;
  readonly session: {
    readonly turns: readonly { readonly role: FlowRefineRole }[];
    readonly currentRole: FlowRefineRole;
    readonly currentModel: { readonly model: string; readonly label: string };
  };
  readonly turns: readonly FlowRefineTransportTurn[];
}

export type FlowRefineTransportEventBody =
  | { readonly type: "status"; readonly status: "opening" | "ready" | "running" }
  | { readonly type: "snapshot"; readonly snapshot: FlowRefineTransportSnapshot }
  | { readonly type: "turn"; readonly turn: FlowRefineTransportTurn }
  | {
      readonly type: "action_result";
      readonly actionId: string;
      readonly status: "accepted" | "succeeded" | "rejected" | "failed";
      readonly errorCode?: string;
      readonly turnId?: string;
    }
  | { readonly type: "terminal"; readonly status: string; readonly errorCode?: string };

export type FlowRefineTransportEvent = FlowRefineTransportEventBody & { readonly sequence: number };

export type FlowRefineTransportAction =
  | {
      readonly type: "run";
      readonly actionId: string;
      readonly role: FlowRefineRole;
      readonly model: string;
      readonly modelLabel: string;
      readonly userInput: string;
    }
  | { readonly type: "apply"; readonly actionId: string; readonly turnId: string }
  | { readonly type: "discard"; readonly actionId: string }
  | { readonly type: "cancel"; readonly actionId: string }
  | { readonly type: "snapshot_request"; readonly actionId: string };

export interface FlowRefineTransportRequest {
  readonly sessionId: string;
  readonly refineSessionId: string;
  readonly operationId: number;
  readonly target: {
    readonly sessionId: string;
    readonly endpointId?: string;
    readonly normalizedCwd: string;
    readonly processGeneration?: number;
  };
  readonly cwd: string;
  readonly mode: string;
  readonly markdown: string;
  readonly revision: number;
  readonly initialRole: FlowRefineRole;
  readonly signal: AbortSignal;
  readonly handleAction: (action: FlowRefineTransportAction) => Promise<void>;
}

export interface FlowRefineTransportHandle {
  readonly promise: Promise<{ action: "apply" | "discard" | "cancel"; turnId?: string; terminal?: string }>;
  emit(event: FlowRefineTransportEvent): void;
  finish(result: { action: "apply" | "discard" | "cancel"; turnId?: string }): void;
  cancel(reason: string): void | Promise<void>;
}

export interface FlowRefineTransport {
  open(request: FlowRefineTransportRequest): FlowRefineTransportHandle | undefined;
}

const REFINE_TRANSPORT_REGISTRY = Symbol.for("pi-maestro-flow.refine-transports");

interface RefineTransportRegistry { transports: FlowRefineTransport[] }

function registry(): RefineTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[REFINE_TRANSPORT_REGISTRY] as RefineTransportRegistry | undefined;
  if (existing) return existing;
  const created: RefineTransportRegistry = { transports: [] };
  globals[REFINE_TRANSPORT_REGISTRY] = created;
  return created;
}

export function registerFlowRefineTransport(transport: FlowRefineTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => {
    const index = state.transports.indexOf(transport);
    if (index >= 0) state.transports.splice(index, 1);
  };
}

type RefineClient = {
  target: DesktopPluginTarget;
  sendPlanRefine(message: DesktopPlanRefineAction | DesktopPlanRefineSnapshot | DesktopPlanRefineUpdate): Promise<void>;
};

interface PendingRefine {
  readonly request: FlowRefineTransportRequest;
  readonly handle: FlowRefineTransportHandle;
  /** Latest selection pushed by the phone; the wire sends role/model separately. */
  role: FlowRefineRole;
  model: string;
  modelLabel: string;
  /** Most recent turn id, required by Flow's apply guard. */
  latestTurnId?: string;
  /** Latest authoritative snapshot, re-broadcast when a selection changes. */
  latestSnapshot?: FlowRefineTransportSnapshot;
  latestSequence?: number;
  readonly actions: Map<string, { fingerprint: string; promise: Promise<boolean> }>;
  sendTail: Promise<void>;
  resolve(result: { action: "apply" | "discard" | "cancel"; turnId?: string; terminal?: string }): void;
  removeAbortListener(): void;
}

export interface DesktopRefineTransport extends FlowRefineTransport {
  /** Relay one Mobile action into the live Flow refine session. */
  handleAction(action: DesktopPlanRefineAction): Promise<boolean>;
  /** Replay the current snapshot after a reconnect. */
  resendPending(client?: RefineClient): Promise<void>;
  cancelAll(): void;
  readonly pendingCount: number;
}

function sameTarget(left: DesktopPluginTarget, right: DesktopPluginTarget | undefined): boolean {
  return right !== undefined
    && left.sessionId === right.sessionId
    && left.endpointId === right.endpointId
    && left.normalizedCwd === right.normalizedCwd
    && left.processGeneration === right.processGeneration;
}

function turnToWire(turn: FlowRefineTransportTurn): DesktopPlanRefineTurn {
  return {
    turnId: turn.turnId,
    role: turn.role,
    model: turn.modelLabel,
    userInput: turn.userInput,
    output: turn.output,
    status: "succeeded",
    appliesAs: turn.appliesAs,
    createdAt: Date.parse(turn.createdAt) || Date.now(),
  };
}

function snapshotToWire(
  request: FlowRefineTransportRequest,
  snapshot: FlowRefineTransportSnapshot,
  target: DesktopPluginTarget,
  sequence: number,
): DesktopPlanRefineSnapshot {
  return {
    type: "desktop_plan_refine_snapshot",
    target,
    refineSessionId: snapshot.refineSessionId,
    planRequestId: request.refineSessionId,
    operationId: snapshot.operationId,
    revision: snapshot.revision,
    sequence,
    status: snapshot.status,
    markdown: request.markdown,
    turns: snapshot.turns.map(turnToWire),
    currentRole: snapshot.session.currentRole,
    currentModel: snapshot.session.currentModel.model,
    modelOptions: snapshot.session.currentModel.model
      ? [{ id: snapshot.session.currentModel.model, name: snapshot.session.currentModel.label }]
      : [],
    availableActions: ["select_role", "select_model", "run", "apply", "discard", "cancel"],
  };
}

function enqueueFrame(entry: PendingRefine, client: RefineClient, frame: DesktopPlanRefineSnapshot | DesktopPlanRefineUpdate): void {
  entry.sendTail = entry.sendTail
    .catch(() => undefined)
    .then(() => client.sendPlanRefine(frame))
    .catch((error) => {
      void appendFile("/tmp/refine-diag.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "flow-refine-send-failed", error: error instanceof Error ? error.message : String(error), frameType: frame.type }) + "\n").catch(() => {});
      console.error(`[refine-transport] sendPlanRefine FAILED:`, error);
    });
}

export function createDesktopRefineTransport(options: {
  getClient: () => RefineClient | undefined;
  isCurrent: (request: FlowRefineTransportRequest) => boolean;
  supportsRefine: () => boolean;
  /**
   * The session's current runtime model (`provider/modelId`). Used only when a
   * refine snapshot arrives without one, so the phone still has a runnable model.
   */
  getSessionModel?: () => string | undefined;
}): DesktopRefineTransport {
  const pending = new Map<string, PendingRefine>();

  const keyOf = (request: FlowRefineTransportRequest): string => request.refineSessionId;

  const transport: DesktopRefineTransport = {
    open(request) {
      if (!options.supportsRefine()) return undefined;
      if (!options.isCurrent(request) || request.signal.aborted) return undefined;
      const key = keyOf(request);
      if (pending.has(key)) return undefined;

      let resolvePromise!: (result: { action: "apply" | "discard" | "cancel"; turnId?: string; terminal?: string }) => void;
      const promise = new Promise<{ action: "apply" | "discard" | "cancel"; turnId?: string; terminal?: string }>((resolve) => {
        resolvePromise = resolve;
      });

      const settle = (result: { action: "apply" | "discard" | "cancel"; turnId?: string; terminal?: string }): boolean => {
        const entry = pending.get(key);
        if (!entry) return false;
        pending.delete(key);
        entry.removeAbortListener();
        entry.resolve(result);
        return true;
      };

      const handle: FlowRefineTransportHandle = {
        promise,
        emit(event) {
          const entry = pending.get(key);
          if (!entry) return;
          const client = options.getClient();
          if (!client) return;
          if (event.type === "snapshot") {
            entry.latestSnapshot = event.snapshot;
            entry.latestSequence = event.sequence;
            entry.role = event.snapshot.session.currentRole;
            entry.model = event.snapshot.session.currentModel.model;
            entry.modelLabel = event.snapshot.session.currentModel.label;
            // A refine session runs on the main session's model by default. If the
            // snapshot arrived without one, adopt the session's real runtime model
            // rather than leaving the phone unable to start a run.
            if (!entry.model) {
              const runtimeModel = options.getSessionModel?.();
              if (runtimeModel) {
                entry.model = runtimeModel;
                entry.modelLabel = runtimeModel;
              }
            }
            enqueueFrame(entry, client, snapshotToWire(entry.request, event.snapshot, client.target, event.sequence));
            return;
          }
          if (event.type === "action_result") {
            enqueueFrame(entry, client, {
              type: "desktop_plan_refine_update",
              target: client.target,
              refineSessionId: entry.request.refineSessionId,
              planRequestId: entry.request.refineSessionId,
              operationId: entry.request.operationId,
              revision: entry.request.revision,
              sequence: event.sequence,
              status: event.status === "accepted" ? "running" : "ready",
              actionResult: {
                actionId: event.actionId,
                status: event.status,
                ...(event.turnId ? { turnId: event.turnId } : {}),
                ...(event.errorCode ? { error: { code: event.errorCode } } : {}),
              },
            });
            return;
          }
          if (event.type === "terminal") {
            enqueueFrame(entry, client, {
              type: "desktop_plan_refine_update",
              target: client.target,
              refineSessionId: entry.request.refineSessionId,
              planRequestId: entry.request.refineSessionId,
              operationId: entry.request.operationId,
              revision: entry.request.revision,
              sequence: event.sequence,
              status: event.status as DesktopPlanRefineUpdate["status"],
              ...(event.errorCode ? { error: { code: event.errorCode } } : {}),
            });
            const action = event.status === "discarded" ? "discard"
              : event.status === "cancelled" || event.status === "disconnected" || event.status === "failed" || event.status === "revision_conflict" ? "cancel"
                : "apply";
            settle({ action, terminal: event.status });
            return;
          }
          if (event.type === "status") {
            enqueueFrame(entry, client, {
              type: "desktop_plan_refine_update",
              target: client.target,
              refineSessionId: entry.request.refineSessionId,
              planRequestId: entry.request.refineSessionId,
              operationId: entry.request.operationId,
              revision: entry.request.revision,
              sequence: event.sequence,
              status: event.status,
            });
            return;
          }
          if (event.type === "turn") {
            entry.latestTurnId = event.turn.turnId;
            enqueueFrame(entry, client, {
              type: "desktop_plan_refine_update",
              target: client.target,
              refineSessionId: entry.request.refineSessionId,
              planRequestId: entry.request.refineSessionId,
              operationId: entry.request.operationId,
              revision: entry.request.revision,
              sequence: event.sequence,
              status: "ready",
              turn: turnToWire(event.turn),
            });
          }
          // action_result frames are Host-local correlation; Mobile learns the
          // outcome from the turn/status/terminal projections it already gets.
        },
        finish(result) {
          resolvePromise(result);
        },
        cancel() {
          settle({ action: "cancel" });
        },
      };

      const onAbort = (): void => {
        // An aborted Flow signal is not a user decision. Drop the mirror
        // without settling the promise so the local overlay stays the only
        // authority for the outcome.
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        entry.removeAbortListener();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      const entry: PendingRefine = {
        request,
        handle,
        role: request.initialRole,
        model: "",
        modelLabel: "",
        actions: new Map(),
        sendTail: Promise.resolve(),
        resolve: resolvePromise,
        removeAbortListener: () => request.signal.removeEventListener("abort", onAbort),
      };
      pending.set(key, entry);

      return handle;
    },

    async handleAction(action) {
      void appendFile("/tmp/refine-diag.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "flow-refine-handleAction", action: action.action.action, refineSessionId: action.refineSessionId, pendingSize: pending.size }) + "\n").catch(() => {});
      console.log(`[refine-host-handle] action=${action.action.action} sessionId=${action.refineSessionId} pendingSize=${pending.size}`);
      const entry = pending.get(action.refineSessionId);
      if (!entry) {
        void appendFile("/tmp/refine-diag.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "flow-refine-rejected-no-entry", refineSessionId: action.refineSessionId, availableKeys: [...pending.keys()] }) + "\n").catch(() => {});
        console.log(`[refine-host-handle] REJECTED: pending entry not found for ${action.refineSessionId}; available keys: ${[...pending.keys()].join(",")}`);
        return false;
      }
      if (action.planRequestId !== entry.request.refineSessionId
        || action.operationId !== entry.request.operationId
        || action.revision !== entry.request.revision
        || !sameTarget(action.target, options.getClient()?.target)) {
        void appendFile("/tmp/refine-diag.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "flow-refine-rejected-mismatch", planRequestId: action.planRequestId === entry.request.refineSessionId, opId: action.operationId === entry.request.operationId, rev: action.revision === entry.request.revision, targetMatch: sameTarget(action.target, options.getClient()?.target) }) + "\n").catch(() => {});
        console.log(`[refine-host-handle] REJECTED: match mismatch: planRequestId=${action.planRequestId===entry.request.refineSessionId} opId=${action.operationId===entry.request.operationId} rev=${action.revision===entry.request.revision} target=${sameTarget(action.target, options.getClient()?.target)}`);
        return false;
      }
      const fingerprint = JSON.stringify({
        target: action.target,
        refineSessionId: action.refineSessionId,
        planRequestId: action.planRequestId,
        operationId: action.operationId,
        revision: action.revision,
        action: action.action,
      });
      const prior = entry.actions.get(action.actionId);
      if (prior) return prior.fingerprint === fingerprint ? prior.promise : false;
      const promise = (async (): Promise<boolean> => {
        if (action.action.action === "apply" && action.action.turnId !== entry.latestTurnId) return false;
        // Selection is Host-side state: Flow only receives the resolved run.
        if (applySelection(action.action, entry)) {
          // Selection lives on the Host, so echo it back: without this the phone
          // keeps rendering the snapshot's original role/model and a picked model
          // never appears selected.
          const snap = entry.latestSnapshot;
          const client = options.getClient();
          if (snap && client) {
            entry.latestSequence = (entry.latestSequence ?? 0) + 1;
            enqueueFrame(entry, client, snapshotToWire(
              entry.request,
              { ...snap, session: { ...snap.session, currentRole: entry.role, currentModel: { model: entry.model, label: entry.modelLabel } } },
              client.target,
              entry.latestSequence,
            ));
          }
          return true;
        }
        const payload = actionToFlow(action, entry);
        if (!payload) return false;
        try {
          await entry.request.handleAction(payload);
          return true;
        } catch {
          return false;
        }
      })();
      entry.actions.set(action.actionId, { fingerprint, promise });
      return promise;
    },

    async resendPending() {
      for (const entry of pending.values()) {
        await entry.request.handleAction({ type: "snapshot_request", actionId: randomUUID() });
      }
    },

    cancelAll() {
      for (const key of [...pending.keys()]) {
        const entry = pending.get(key);
        if (!entry) continue;
        pending.delete(key);
        entry.removeAbortListener();
        entry.resolve({ action: "cancel" });
      }
    },

    get pendingCount() {
      return pending.size;
    },
  };

  return transport;
}

interface RefineSelectionState {
  role: FlowRefineRole;
  model: string;
  modelLabel: string;
  latestTurnId?: string;
}

function actionToFlow(
  action: DesktopPlanRefineAction,
  state: RefineSelectionState,
): FlowRefineTransportAction | undefined {
  const actionId = action.actionId;
  void appendFile("/tmp/refine-diag.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "flow-refine-actionToFlow", action: action.action.action, model: state.model, role: state.role }) + "\n").catch(() => {});
  console.log(`[refine-host-flow] actionToFlow action=${action.action.action} state.model=${state.model} state.role=${state.role}`);
  switch (action.action.action) {
    case "run":
      if (!state.model) {
        void appendFile("/tmp/refine-diag.jsonl", JSON.stringify({ at: new Date().toISOString(), event: "flow-refine-rejected-empty-model" }) + "\n").catch(() => {});
        console.log(`[refine-host-flow] REJECTED: state.model is empty!`);
        return undefined;
      }
      return {
        type: "run",
        actionId,
        role: state.role,
        model: state.model,
        modelLabel: state.modelLabel || state.model,
        userInput: action.action.userInput,
      };
    case "apply":
      if (!state.latestTurnId) return undefined;
      return { type: "apply", actionId, turnId: state.latestTurnId };
    case "discard":
      return { type: "discard", actionId };
    case "cancel":
      return { type: "cancel", actionId };
    case "snapshot":
      return { type: "snapshot_request", actionId };
    default:
      return undefined;
  }
}

/** Selection actions mutate only Host-side state; they never reach Flow directly. */
function applySelection(action: DesktopPlanRefineActionPayload, state: RefineSelectionState): boolean {
  if (action.action === "select_role") {
    state.role = action.role;
    return true;
  }
  if (action.action === "select_model") {
    state.model = action.model;
    state.modelLabel = action.model;
    return true;
  }
  return false;
}

export { snapshotToWire, turnToWire, actionToFlow, applySelection, DESKTOP_PLAN_REFINE_FEATURE };

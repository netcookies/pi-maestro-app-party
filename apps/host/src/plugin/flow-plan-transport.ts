import type {
  DesktopPlanDecision,
  DesktopPlanRequest,
  DesktopPlanResponse,
} from "@maestro-mobile/shared";

export type FlowPlanCancelReason = "remote_answered" | "tui_answered" | "cancelled" | "aborted" | "transport_error";

export interface FlowPlanTransportRequest {
  readonly kind: "confirm" | "review";
  readonly sessionId: string;
  readonly operationId: number;
  readonly cwd: string;
  readonly mode: string;
  readonly sessionFile?: string;
  readonly markdown: string;
  readonly revision: number;
  readonly pathLabel: string;
  readonly availableActions: readonly string[];
  readonly defaultExecution?: DesktopPlanRequest["defaultExecution"];
  readonly workflow?: DesktopPlanRequest["workflow"];
  readonly modelTransition?: DesktopPlanRequest["modelTransition"];
  readonly decisionDocuments: readonly string[];
  readonly drafts: readonly DesktopPlanRequest["drafts"][number][];
  readonly signal: AbortSignal;
}

export type FlowPlanTransportResult =
  | { status: "decision"; decision: DesktopPlanDecision }
  | { status: "edited"; markdown: string; expectedRevision: number }
  | { status: "cancelled" };

export interface FlowPlanTransportHandle {
  readonly promise: Promise<FlowPlanTransportResult>;
  cancel(reason: FlowPlanCancelReason): void | Promise<void>;
}

export interface FlowPlanTransport {
  open(request: FlowPlanTransportRequest): FlowPlanTransportHandle | undefined;
}

const PLAN_TRANSPORT_REGISTRY = Symbol.for("pi-maestro-flow.plan-transports");

interface PlanTransportRegistry { transports: FlowPlanTransport[]; }
function registry(): PlanTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[PLAN_TRANSPORT_REGISTRY] as PlanTransportRegistry | undefined;
  if (existing) return existing;
  const created: PlanTransportRegistry = { transports: [] };
  globals[PLAN_TRANSPORT_REGISTRY] = created;
  return created;
}

export function registerFlowPlanTransport(transport: FlowPlanTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => {
    const index = state.transports.indexOf(transport);
    if (index >= 0) state.transports.splice(index, 1);
  };
}

function keyOf(requestId: string, kind: string): string {
  return JSON.stringify([requestId, kind]);
}

function desktopRequestFromFlow(request: FlowPlanTransportRequest): DesktopPlanRequest {
  return {
    type: "desktop_plan_request",
    requestId: `plan:${request.sessionId}:${request.operationId}`,
    kind: request.kind,
    sessionId: request.sessionId,
    operationId: request.operationId,
    cwd: request.cwd,
    mode: request.mode,
    ...(request.sessionFile ? { sessionFile: request.sessionFile } : {}),
    markdown: request.markdown,
    revision: request.revision,
    pathLabel: request.pathLabel,
    availableActions: [...request.availableActions],
    ...(request.defaultExecution ? { defaultExecution: request.defaultExecution } : {}),
    ...(request.workflow ? { workflow: request.workflow } : {}),
    ...(request.modelTransition ? { modelTransition: request.modelTransition } : {}),
    decisionDocuments: [...request.decisionDocuments],
    drafts: [...request.drafts],
  };
}

function flowResultFromDesktop(response: DesktopPlanResponse): FlowPlanTransportResult {
  if (response.status === "cancelled") return { status: "cancelled" };
  if (response.status === "edited") {
    return { status: "edited", markdown: response.markdown, expectedRevision: response.expectedRevision };
  }
  return { status: "decision", decision: response.decision };
}

type PlanClient = {
  sendPlanRequest(request: DesktopPlanRequest): Promise<void>;
  sendPlanCancellation(request: DesktopPlanRequest): Promise<void>;
};

interface PendingPlan {
  request: DesktopPlanRequest;
  resolve(result: FlowPlanTransportResult): void;
  removeAbortListener(): void;
}

export interface DesktopPlanTransport extends FlowPlanTransport {
  handleResponse(response: DesktopPlanResponse): boolean;
  resendPending(client?: PlanClient): Promise<void>;
  cancelAll(): void;
  readonly pendingCount: number;
}

export function createDesktopPlanTransport(options: {
  getClient: () => PlanClient | undefined;
  isCurrent: (request: FlowPlanTransportRequest) => boolean;
}): DesktopPlanTransport {
  const pending = new Map<string, PendingPlan>();

  const settle = (key: string, result: FlowPlanTransportResult): boolean => {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    entry.removeAbortListener();
    entry.resolve(result);
    return true;
  };

  const send = async (client: PlanClient, entry: PendingPlan): Promise<void> => {
    if (!pending.has(keyOf(entry.request.requestId, entry.request.kind))) return;
    try {
      await client.sendPlanRequest(entry.request);
    } catch {
      // Keep the operation pending; the next connection replays the same
      // request identity while the originating TUI remains active.
    }
  };

  const transport: DesktopPlanTransport = {
    open(request) {
      if (!options.isCurrent(request) || request.signal.aborted) return undefined;
      const desktopRequest = desktopRequestFromFlow(request);
      const key = keyOf(desktopRequest.requestId, desktopRequest.kind);
      if (pending.has(key)) return undefined;

      let resolvePromise!: (result: FlowPlanTransportResult) => void;
      const promise = new Promise<FlowPlanTransportResult>((resolve) => {
        resolvePromise = resolve;
      });
      const onAbort = (): void => {
        void cancel();
      };
      const removeAbortListener = (): void => request.signal.removeEventListener("abort", onAbort);
      const entry: PendingPlan = {
        request: desktopRequest,
        resolve: resolvePromise,
        removeAbortListener,
      };
      const cancel = async (): Promise<void> => {
        if (!settle(key, { status: "cancelled" })) return;
        try {
          await options.getClient()?.sendPlanCancellation(desktopRequest);
        } catch {
          // Local settlement is authoritative when the remote connection is gone.
        }
      };

      request.signal.addEventListener("abort", onAbort, { once: true });
      pending.set(key, entry);
      const client = options.getClient();
      if (client) void send(client, entry);
      return { promise, cancel };
    },
    handleResponse(response) {
      return settle(keyOf(response.requestId, response.kind), flowResultFromDesktop(response));
    },
    async resendPending(client = options.getClient()) {
      if (!client) return;
      for (const [, entry] of [...pending]) {
        await send(client, entry);
      }
    },
    cancelAll() {
      for (const key of [...pending.keys()]) settle(key, { status: "cancelled" });
    },
    get pendingCount() {
      return pending.size;
    },
  };

  return transport;
}

export { desktopRequestFromFlow, flowResultFromDesktop };

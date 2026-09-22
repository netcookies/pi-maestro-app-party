export interface FlowAskQuestionOption {
  label: string;
  description?: string;
}

export interface FlowAskQuestionSpec {
  question: string;
  header?: string;
  options?: FlowAskQuestionOption[];
  multiSelect?: boolean;
}

export interface FlowAskAnswer {
  question: string;
  header?: string;
  selected: string[];
  details?: Record<string, string>;
  text?: string;
}

export type FlowAskTransportCancelReason =
  | "remote_answered"
  | "tui_answered"
  | "cancelled"
  | "aborted"
  | "transport_error";

export interface FlowAskTransportRequest {
  readonly toolCallId: string;
  readonly questions: readonly FlowAskQuestionSpec[];
  readonly cwd: string;
  readonly mode: string;
  readonly sessionFile?: string;
  readonly signal: AbortSignal;
}

export type FlowAskTransportResult =
  | { status: "answered"; answers: FlowAskAnswer[] }
  | { status: "cancelled" };

export interface FlowAskTransportHandle {
  readonly promise: Promise<FlowAskTransportResult>;
  cancel(reason: FlowAskTransportCancelReason): void | Promise<void>;
}

export interface FlowAskTransport {
  open(request: FlowAskTransportRequest): FlowAskTransportHandle | undefined;
}

const ASK_TRANSPORT_REGISTRY = Symbol.for("pi-maestro-flow.ask-transports");

interface AskTransportRegistry {
  transports: FlowAskTransport[];
}

function registry(): AskTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[ASK_TRANSPORT_REGISTRY] as AskTransportRegistry | undefined;
  if (existing) return existing;
  const created: AskTransportRegistry = { transports: [] };
  globals[ASK_TRANSPORT_REGISTRY] = created;
  return created;
}

/** 与 Flow 公共 ask-transport 模块共享同一个进程内 registry。 */
export function registerFlowAskTransport(transport: FlowAskTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => {
    const index = state.transports.indexOf(transport);
    if (index >= 0) state.transports.splice(index, 1);
  };
}

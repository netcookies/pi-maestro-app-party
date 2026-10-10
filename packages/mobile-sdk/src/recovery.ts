import type { MobileClient } from "./client.js";
import type {
  ExecutionProjection,
  HostEvent,
  HostSessionList,
  MaestroState,
  SessionSnapshot,
  SessionTargetIdentity,
} from "./protocol/index.js";
import { isExecutionProjection, isSessionTargetIdentity, sessionTargetKey } from "./protocol/index.js";

const SNAPSHOT_OVERLAP_TYPES = new Set<HostEvent["type"]>([
  "session_updated", "timeline_item", "timeline_delta", "timeline_snapshot", "session_summary_updated",
]);
export const DEFAULT_RECOVERY_BUFFER_BYTES = 32 * 1024 * 1024;
type RecoveryClient = Pick<MobileClient,
  "getSnapshot" | "getExecutionProjections" | "sendCommand" | "onEvent" | "onConnectionState" | "connectionState"
>;
export type RecoveryBootstrapQuery = "execution_projections" | "maestro_state" | "host_sessions";
export type RecoveryUpdate =
  | { type: "reset"; generation: number }
  | { type: "event"; generation: number; event: HostEvent; target?: SessionTargetIdentity }
  | { type: "snapshot"; generation: number; requestGeneration: number; target: SessionTargetIdentity; snapshot: SessionSnapshot; replayedEvents: HostEvent[] }
  | { type: "bootstrap"; generation: number; query: "execution_projections"; result: { projections: ExecutionProjection[]; revision: number } }
  | { type: "bootstrap"; generation: number; query: "maestro_state"; result: MaestroState }
  | { type: "bootstrap"; generation: number; query: "host_sessions"; result: HostSessionList }
  | { type: "recovery_error"; generation: number; target: SessionTargetIdentity; requestGeneration: number; error: Error }
  | { type: "bootstrap_error"; generation: number; query: RecoveryBootstrapQuery; error: Error };
export type RecoveryOutcome =
  | { status: "applied"; generation: number; requestGeneration: number; snapshot: SessionSnapshot; replayedEvents: HostEvent[] }
  | { status: "superseded" | "cancelled" | "connection_lost" | "disposed"; generation: number; requestGeneration: number };
export class RecoveryCancelledError extends Error {
  readonly code = "recovery_cancelled";
  constructor() { super("Snapshot recovery was cancelled locally"); this.name = "RecoveryCancelledError"; }
}
export class RecoveryBufferOverflowError extends Error {
  readonly code = "recovery_buffer_overflow";
  constructor(readonly bytes: number, readonly limit: number) {
    super(`Snapshot recovery buffer exceeded ${limit} bytes`);
    this.name = "RecoveryBufferOverflowError";
  }
}
export class RecoveryInvalidResponseError extends Error {
  readonly code = "recovery_invalid_response";
  constructor(readonly query: "snapshot" | RecoveryBootstrapQuery) {
    super(`Invalid ${query} response`);
    this.name = "RecoveryInvalidResponseError";
  }
}
export interface RecoveryOptions {
  onUpdate?: (update: RecoveryUpdate) => void;
  maxBufferedBytes?: number;
}
export interface RecoveryCoordinator {
  readonly generation: number;
  setActiveTarget(target: SessionTargetIdentity | null): void;
  recoverSession(target: SessionTargetIdentity, options?: { signal?: AbortSignal }): Promise<RecoveryOutcome>;
  /** Single-flight bootstrap and active-target recovery, also run after each handshake. Errors are updates. */
  refresh(): Promise<void>;
  resetConnection(): void;
  cancel(target: SessionTargetIdentity): void;
  onUpdate(listener: (update: RecoveryUpdate) => void): () => void;
  getWatermarks(target: SessionTargetIdentity): { nextSeq?: number; wireSeq?: number };
  dispose(): void;
}
interface BufferedEvent { event: HostEvent; bytes: number }
interface Watermark { wireSeq?: number; nextSeq?: number }
interface Flight {
  target: SessionTargetIdentity;
  key: string;
  requestGeneration: number;
  generation: number;
  buffer: BufferedEvent[];
  bufferedBytes: number;
  bufferedSeq: number;
  settled: boolean;
  controller: AbortController;
  promise: Promise<RecoveryOutcome>;
  resolve: (outcome: RecoveryOutcome) => void;
  reject: (error: Error) => void;
  removeAbort?: () => void;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function assertSnapshot(value: unknown, target: SessionTargetIdentity): asserts value is SessionSnapshot {
  if (!isRecord(value) || !isRecord(value.session) || value.session.id !== target.sessionId
    || typeof value.session.cwd !== "string" || typeof value.session.title !== "string"
    || !["idle", "streaming", "compacting", "aborting", "error"].includes(String(value.session.runState))
    || !isNonNegativeInteger(value.session.messageCount) || !isNonNegativeInteger(value.session.pendingMessageCount)
    || typeof value.session.updatedAt !== "string" || !Array.isArray(value.timeline)
    || !value.timeline.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.text === "string"
      && typeof item.createdAt === "string" && ["user", "assistant", "thinking", "tool", "system"].includes(String(item.kind)))
    || !isNonNegativeInteger(value.nextSeq) || (value.wireSeq !== undefined && !isNonNegativeInteger(value.wireSeq))
    || (value.historyAvailable !== undefined && typeof value.historyAvailable !== "boolean")
    || (value.hasMoreHistory !== undefined && typeof value.hasMoreHistory !== "boolean")) {
    throw new RecoveryInvalidResponseError("snapshot");
  }
}
function isProjectionResult(value: unknown): value is { projections: ExecutionProjection[]; revision: number } {
  return isRecord(value) && Array.isArray(value.projections) && value.projections.every(isExecutionProjection)
    && isNonNegativeInteger(value.revision);
}
function isMaestroResult(value: unknown): value is MaestroState {
  return isRecord(value) && Array.isArray(value.schedules) && value.schedules.every(isRecord) && typeof value.observedAt === "string";
}
function isSessionListResult(value: unknown): value is HostSessionList {
  return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isRecord) && typeof value.observedAt === "string";
}
/** Lone surrogates encode as replacement characters; a non-low successor is not consumed. */
export function recoveryUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
function targetOf(event: HostEvent): SessionTargetIdentity | undefined {
  return "target" in event && event.target ? event.target : undefined;
}
function independentKey(event: HostEvent, target?: SessionTargetIdentity): string {
  // Independent categories and legacy untargeted events never advance exact-target snapshot watermarks.
  const scope = target ?? ("projection" in event ? event.projection.target
    : "summary" in event ? event.summary.target
      : "sessionId" in event ? event.sessionId
        : "session" in event ? event.session.id : null);
  return JSON.stringify([event.type, scope]);
}
const coordinators = new WeakMap<object, RecoveryCoordinator>();

export function createMobileRecovery(client: RecoveryClient, options: RecoveryOptions = {}): RecoveryCoordinator {
  if (coordinators.has(client)) throw new Error("MobileClient already has a recovery coordinator");
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_RECOVERY_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 0) throw new RangeError("maxBufferedBytes must be a nonnegative safe integer");
  let generation = 0;
  let requestSeq = 0;
  let disposed = false;
  let wasConnected = client.connectionState === "connected";
  let activeTarget: SessionTargetIdentity | null = null;
  let bufferedTotal = 0;
  let refreshFlight: Promise<void> | null = null;
  let refreshController: AbortController | null = null;
  const listeners = new Set<(update: RecoveryUpdate) => void>();
  const flights = new Map<string, Flight>();
  const watermarks = new Map<string, Watermark>();
  const independentSeq = new Map<string, number>();

  const emit = (update: RecoveryUpdate): void => {
    if (disposed) return;
    options.onUpdate?.(update);
    for (const listener of listeners) listener(update);
  };
  const takeBuffer = (flight: Flight): BufferedEvent[] => {
    const buffer = flight.buffer;
    bufferedTotal -= flight.bufferedBytes;
    flight.buffer = [];
    flight.bufferedBytes = 0;
    return buffer;
  };
  const detach = (flight: Flight): BufferedEvent[] => {
    flight.settled = true;
    if (flights.get(flight.key) === flight) flights.delete(flight.key);
    flight.removeAbort?.();
    flight.removeAbort = undefined;
    flight.controller.abort();
    return takeBuffer(flight);
  };
  const cancelFlight = (flight: Flight, status: Exclude<RecoveryOutcome["status"], "applied">, replay: boolean): void => {
    if (flight.settled) return;
    const buffer = detach(flight);
    flight.resolve({ status, generation: flight.generation, requestGeneration: flight.requestGeneration });
    if (replay && flight.generation === generation && !disposed) for (const item of buffer) acceptLive(item.event);
  };
  const failFlight = (flight: Flight, error: Error): void => {
    if (flight.settled) return;
    const buffer = detach(flight);
    flight.reject(error);
    if (flight.generation !== generation || disposed) return;
    for (const item of buffer) acceptLive(item.event);
    emit({ type: "recovery_error", generation, target: flight.target, requestGeneration: flight.requestGeneration, error });
  };
  const acceptSequenced = (event: HostEvent): boolean => {
    const target = targetOf(event);
    if (SNAPSHOT_OVERLAP_TYPES.has(event.type) && target) {
      const key = sessionTargetKey(target);
      const mark = watermarks.get(key) ?? {};
      if (event.seq <= (mark.wireSeq ?? -1)) return false;
      mark.wireSeq = event.seq;
      watermarks.set(key, mark);
    } else {
      const key = independentKey(event, target);
      if (event.seq <= (independentSeq.get(key) ?? -1)) return false;
      independentSeq.set(key, event.seq);
    }
    return true;
  };
  const acceptLive = (event: HostEvent): void => {
    if (disposed || client.connectionState !== "connected") return;
    const target = targetOf(event);
    const flight = SNAPSHOT_OVERLAP_TYPES.has(event.type) && target ? flights.get(sessionTargetKey(target)) : undefined;
    if (flight && flight.generation === generation) {
      if (event.seq <= flight.bufferedSeq) return;
      const bytes = recoveryUtf8ByteLength(JSON.stringify(event));
      flight.buffer.push({ event, bytes });
      flight.bufferedSeq = event.seq;
      flight.bufferedBytes += bytes;
      bufferedTotal += bytes;
      // The triggering frame is the sole transient allowance above the global budget, and is flushed too.
      if (bufferedTotal > maxBufferedBytes) failFlight(flight, new RecoveryBufferOverflowError(bufferedTotal, maxBufferedBytes));
      return;
    }
    if (acceptSequenced(event)) emit({ type: "event", generation, event, ...(target ? { target } : {}) });
  };
  const acceptSnapshot = (flight: Flight, raw: unknown): void => {
    if (flight.settled || disposed || flight.generation !== generation || flights.get(flight.key) !== flight) return;
    assertSnapshot(raw, flight.target);
    const mark = watermarks.get(flight.key) ?? {};
    const wireSeq = raw.wireSeq;
    const staleWire = wireSeq !== undefined && mark.wireSeq !== undefined && wireSeq <= mark.wireSeq;
    const staleLegacy = wireSeq === undefined && (mark.wireSeq !== undefined || flight.buffer.length > 0);
    const staleLocal = raw.nextSeq > 0 && mark.nextSeq !== undefined && raw.nextSeq < mark.nextSeq;
    if (staleWire || staleLegacy || staleLocal) {
      cancelFlight(flight, "superseded", true);
      return;
    }
    if (wireSeq !== undefined) mark.wireSeq = Math.max(mark.wireSeq ?? -1, wireSeq - 1);
    mark.nextSeq = Math.max(mark.nextSeq ?? -1, raw.nextSeq);
    watermarks.set(flight.key, mark);
    const buffer = detach(flight);
    const replayedEvents: HostEvent[] = [];
    for (const item of buffer) {
      if (wireSeq !== undefined && item.event.seq < wireSeq) continue;
      if (acceptSequenced(item.event)) replayedEvents.push(item.event);
    }
    const outcome: RecoveryOutcome = { status: "applied", generation, requestGeneration: flight.requestGeneration, snapshot: raw, replayedEvents };
    flight.resolve(outcome);
    emit({ type: "snapshot", generation, requestGeneration: flight.requestGeneration, target: flight.target, snapshot: raw, replayedEvents });
  };
  const recoverSession = (target: SessionTargetIdentity, requestOptions: { signal?: AbortSignal } = {}): Promise<RecoveryOutcome> => {
    if (!isSessionTargetIdentity(target)) return Promise.reject(new Error("Invalid session target"));
    if (disposed) return Promise.resolve({ status: "disposed", generation, requestGeneration: ++requestSeq });
    if (requestOptions.signal?.aborted) return Promise.resolve({ status: "cancelled", generation, requestGeneration: ++requestSeq });
    const key = sessionTargetKey(target);
    const previous = flights.get(key);
    const inherited = previous ? takeBuffer(previous) : [];
    if (previous) cancelFlight(previous, "superseded", false);
    let resolve!: Flight["resolve"];
    let reject!: Flight["reject"];
    const promise = new Promise<RecoveryOutcome>((res, rej) => { resolve = res; reject = rej; });
    const flight: Flight = {
      target: { ...target }, key, generation, requestGeneration: ++requestSeq, buffer: inherited,
      bufferedBytes: inherited.reduce((n, x) => n + x.bytes, 0), bufferedSeq: inherited.at(-1)?.event.seq ?? watermarks.get(key)?.wireSeq ?? -1,
      controller: new AbortController(), settled: false, promise, resolve, reject,
    };
    bufferedTotal += flight.bufferedBytes;
    flights.set(key, flight);
    const signal = requestOptions.signal;
    if (signal) {
      const abort = () => cancelFlight(flight, "cancelled", true);
      signal.addEventListener("abort", abort, { once: true });
      flight.removeAbort = () => signal.removeEventListener("abort", abort);
    }
    void client.getSnapshot(target.sessionId, flight.target, { signal: flight.controller.signal })
      .then((snapshot) => acceptSnapshot(flight, snapshot))
      .catch((error: unknown) => failFlight(flight, error instanceof Error ? error : new Error(String(error))));
    return promise;
  };
  const resetConnection = (): void => {
    if (disposed) return;
    generation++;
    for (const flight of [...flights.values()]) cancelFlight(flight, "connection_lost", false);
    refreshController?.abort();
    refreshController = null;
    refreshFlight = null;
    watermarks.clear();
    independentSeq.clear();
    emit({ type: "reset", generation });
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshFlight) return refreshFlight;
    const refreshGeneration = generation;
    const controller = new AbortController();
    refreshController = controller;
    const current = () => !disposed && refreshGeneration === generation && !controller.signal.aborted;
    const report = async (query: RecoveryBootstrapQuery, task: Promise<unknown>): Promise<void> => {
      try {
        const result = await task;
        if (!current()) return;
        if (query === "execution_projections" && isProjectionResult(result)) emit({ type: "bootstrap", generation: refreshGeneration, query, result });
        else if (query === "maestro_state" && isMaestroResult(result)) emit({ type: "bootstrap", generation: refreshGeneration, query, result });
        else if (query === "host_sessions" && isSessionListResult(result)) emit({ type: "bootstrap", generation: refreshGeneration, query, result });
        else throw new RecoveryInvalidResponseError(query);
      } catch (error) {
        if (current()) emit({ type: "bootstrap_error", generation: refreshGeneration, query, error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const target = activeTarget;
    const active = target ? flights.get(sessionTargetKey(target))?.promise ?? recoverSession(target) : Promise.resolve();
    const work = Promise.all([
      report("execution_projections", client.getExecutionProjections({ signal: controller.signal })),
      report("maestro_state", client.sendCommand({ type: "get_maestro_state" }, 30_000, controller.signal)),
      report("host_sessions", client.sendCommand({ type: "list_host_sessions", limit: 100 }, 30_000, controller.signal)),
      active.catch(() => undefined),
    ]).then(() => undefined);
    const promise = work.finally(() => {
      if (refreshFlight === promise) { refreshFlight = null; refreshController = null; }
    });
    refreshFlight = promise;
    return promise;
  };
  const offEvent = client.onEvent(acceptLive);
  const offState = client.onConnectionState((state) => {
    if (state === "connected") { wasConnected = true; void refresh(); }
    else if (wasConnected) { wasConnected = false; resetConnection(); }
  });
  const coordinator: RecoveryCoordinator = {
    get generation() { return generation; },
    setActiveTarget(target) { activeTarget = target ? { ...target } : null; },
    recoverSession, refresh, resetConnection,
    cancel(target) { const flight = flights.get(sessionTargetKey(target)); if (flight) cancelFlight(flight, "cancelled", true); },
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getWatermarks(target) { return { ...watermarks.get(sessionTargetKey(target)) }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      offEvent(); offState();
      for (const flight of [...flights.values()]) cancelFlight(flight, "disposed", false);
      refreshController?.abort();
      refreshController = null; refreshFlight = null; activeTarget = null;
      watermarks.clear(); independentSeq.clear(); listeners.clear();
      coordinators.delete(client);
    },
  };
  coordinators.set(client, coordinator);
  if (wasConnected) void refresh();
  return coordinator;
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import net from "node:net";
import type {
  DesktopAskRequest,
  DesktopAskResponse,
  DesktopAskResult,
  DesktopPlanRequest,
  DesktopPlanRefineSnapshot,
  DesktopPlanResponse,
  DesktopPlanResult,
  DesktopBrokerAskResult,
  DesktopBrokerPlanResult,

  DesktopBrokerToHostFrame,
  DesktopPeerDelivery,
  DesktopPeerAccessGrant,
  DesktopPeerAccessDirection,
  DesktopPeerRequest,
  DesktopPeerResult,
  DesktopHostToBrokerFrame,
  DesktopPluginCapability,
  DesktopPluginResult,
  DesktopPluginTarget,
} from "@maestro-mobile/shared";
import {
  DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS,
  DESKTOP_BROKER_PROTOCOL_VERSION,
  isDesktopHostToBrokerFrame,
  DESKTOP_PEER_FEATURE,
  DESKTOP_PEER_MAX_DEADLINE_MS,
  DESKTOP_PEER_MAX_PEERS,
  DESKTOP_PEER_MAX_MESSAGE_BYTES,
  isDesktopPeerAccessGrant,
  MOBILE_RELEASE_VERSION,
} from "@maestro-mobile/shared";
import { JsonLineConnection, DesktopPluginIpcServer } from "./desktop-plugin-ipc.js";
import { DesktopPluginRegistry } from "./desktop-plugin-registry.js";

export interface DesktopBrokerOptions {
  pluginSocketPath: string;
  secret: string;
  registryPath?: string;
  brokerInstanceId?: string;
  registry?: DesktopPluginRegistry;
  snapshotChunkSize?: number;
  onFrame?: (frame: DesktopBrokerToHostFrame) => void;
  crossCwdAllowRules?: readonly { sourceCwd: string; targetCwd: string }[];
  peerAccessPath?: string;
}

export class DesktopBroker {
  readonly brokerInstanceId: string;
  readonly registry: DesktopPluginRegistry;
  readonly pluginServer: DesktopPluginIpcServer;
  private readonly frameListeners = new Set<(frame: DesktopBrokerToHostFrame) => void>();
  private readonly snapshotChunkSize: number;
  private readonly unsubscribeRegistry: () => void;
  private readonly pendingPeerSends = new Map<string, { source: DesktopPluginTarget; target: DesktopPluginTarget; controller: AbortController }>();
  private readonly completedPeerRequests = new Map<string, { result: DesktopPeerResult; expiresAt: number }>();
  private readonly pendingAsks = new Map<string, { target: DesktopPluginTarget; request: DesktopAskRequest }>();
  private readonly persistentPeerAccess = new Map<string, DesktopPeerAccessGrant>();
  private readonly managedPeerAccess: DesktopPeerAccessGrant[];
  private peerAccessLoaded = false;
  private peerAccessWrite: Promise<void> = Promise.resolve();

  private accessKey(sourceCwd: string, targetCwd: string): string { return JSON.stringify([sourceCwd, targetCwd]); }
  private grantAllows(grant: DesktopPeerAccessGrant, sourceCwd: string, targetCwd: string): boolean {
    return (grant.sourceCwd === sourceCwd && grant.targetCwd === targetCwd)
      || (grant.direction === "bidirectional" && grant.sourceCwd === targetCwd && grant.targetCwd === sourceCwd);
  }
  private async loadPeerAccess(): Promise<void> {
    if (this.peerAccessLoaded) return;
    if (!this.options.peerAccessPath) { this.peerAccessLoaded = true; return; }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.peerAccessPath, "utf8"));
      if (!Array.isArray(parsed) || parsed.some((grant) => !isDesktopPeerAccessGrant(grant) || grant.managed)) throw new Error("invalid peer access file");
      if (parsed.length + this.managedPeerAccess.length > DESKTOP_PEER_MAX_PEERS) throw new Error("too many peer grants");
      for (const grant of parsed) {
        const key = this.accessKey(grant.sourceCwd, grant.targetCwd);
        if (this.persistentPeerAccess.has(key)) throw new Error("duplicate peer grant");
        this.persistentPeerAccess.set(key, grant);
      }
      this.peerAccessLoaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.peerAccessLoaded = true; return; }
      this.persistentPeerAccess.clear();
      throw new Error("peer access file is invalid; Broker startup refused", { cause: error });
    }
  }
  private async changePeerAccess<T>(change: (next: Map<string, DesktopPeerAccessGrant>) => T): Promise<T> {
    const task = this.peerAccessWrite.then(async () => {
      if (!this.options.peerAccessPath) throw new Error("peer access persistence unavailable");
      const next = new Map(this.persistentPeerAccess);
      const result = change(next);
      const path = this.options.peerAccessPath;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temp, `${JSON.stringify([...next.values()])}\n`, { mode: 0o600, flag: "wx" });
        await rename(temp, path);
        this.persistentPeerAccess.clear();
        for (const [key, grant] of next) this.persistentPeerAccess.set(key, grant);
        return result;
      } finally { await unlink(temp).catch(() => undefined); }
    });
    this.peerAccessWrite = task.then(() => undefined, () => undefined);
    return task;
  }
  private allPeerAccess(): DesktopPeerAccessGrant[] { return [...this.managedPeerAccess, ...this.persistentPeerAccess.values()]; }

  private askKey(target: DesktopPluginTarget, requestId: string): string {
    return JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration, requestId]);
  }

  private readonly pendingPlanRequests = new Map<string, { target: DesktopPluginTarget; request: DesktopPlanRequest }>();
  private readonly pendingRefineSnapshots = new Map<string, { target: DesktopPluginTarget; message: DesktopPlanRefineSnapshot }>();

  private refineKey(target: DesktopPluginTarget, refineSessionId: string): string {
    return JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration, refineSessionId]);
  }

  private planKey(target: DesktopPluginTarget, requestId: string, kind: DesktopPlanRequest["kind"]): string {
    return JSON.stringify([target.sessionId, target.endpointId, target.normalizedCwd, target.processGeneration, requestId, kind]);
  }

  pendingAskFrames(): DesktopBrokerToHostFrame[] {
    return [...this.pendingAsks.values()]
      .map(({ target, request }) => ({ type: "desktop_broker_ask_request", target, request }));
  }

  pendingPlanFrames(): DesktopBrokerToHostFrame[] {
    return [...this.pendingPlanRequests.values()]
      .map(({ target, request }) => ({ type: "desktop_broker_plan_request", target, request }));
  }

  pendingRefineFrames(): DesktopBrokerToHostFrame[] {
    return [...this.pendingRefineSnapshots.values()]
      .map(({ target, message }) => ({ type: "desktop_broker_plan_refine", target, message }));
  }

  constructor(private readonly options: DesktopBrokerOptions) {
    if (options.crossCwdAllowRules?.some((rule) => !isAbsolute(rule.sourceCwd) || !isAbsolute(rule.targetCwd))) throw new Error("peer allow rules require absolute cwd paths");
    this.managedPeerAccess = (options.crossCwdAllowRules ?? []).map((rule) => ({ grantId: `managed-${Buffer.from(JSON.stringify([normalize(rule.sourceCwd), normalize(rule.targetCwd)])).toString("base64url")}`, sourceCwd: normalize(rule.sourceCwd), targetCwd: normalize(rule.targetCwd), direction: "one_way", createdAt: 0, managed: true }));
    this.brokerInstanceId = options.brokerInstanceId ?? randomUUID();
    this.snapshotChunkSize = options.snapshotChunkSize ?? DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS;
    if (!Number.isSafeInteger(this.snapshotChunkSize) || this.snapshotChunkSize < 1 || this.snapshotChunkSize > DESKTOP_BROKER_MAX_SNAPSHOT_RECORDS) {
      throw new Error("invalid desktop broker snapshot chunk size");
    }
    this.registry = options.registry ?? new DesktopPluginRegistry({
      filePath: options.registryPath,
      brokerInstanceId: this.brokerInstanceId,
    });
    if (options.onFrame) this.frameListeners.add(options.onFrame);
    this.unsubscribeRegistry = this.registry.subscribe((change) => {
      if (change.mutation.kind === "remove") {
        for (const pending of this.pendingPeerSends.values()) {
          const removed = change.mutation.target;
          if (this.samePeerTarget(pending.source, removed) || this.samePeerTarget(pending.target, removed)) pending.controller.abort();
        }
        for (const [key, pending] of this.pendingAsks) {
          if (this.askKey(pending.target, pending.request.requestId) === key
            && this.askKey(change.mutation.target, pending.request.requestId) === key) this.clearAsk(key);
        }
        for (const [key, pending] of this.pendingPlanRequests) {
          if (this.planKey(pending.target, pending.request.requestId, pending.request.kind) === key
            && this.planKey(change.mutation.target, pending.request.requestId, pending.request.kind) === key) this.clearPlan(key);
        }
      }
      this.emit({
        type: "desktop_broker_delta",
        brokerInstanceId: this.brokerInstanceId,
        baseRevision: change.baseRevision,
        revision: change.revision,
        mutation: change.mutation,
      });
    });
    this.pluginServer = new DesktopPluginIpcServer({
      socketPath: options.pluginSocketPath,
      secret: options.secret,
      registry: this.registry,
      onPeerRequest: (source, request, reply) => { void this.handlePeerRequest(source, request).then(reply); },
      onDisconnected: (target) => {
        for (const pending of this.pendingPeerSends.values()) {
          if (this.samePeerTarget(pending.source, target) || this.samePeerTarget(pending.target, target)) pending.controller.abort();
        }
      },
      supportedEvents: ["model_select", "thinking_level_select", "runtime_status", "session_summary", "execution_summary"],
      onAskRequest: (target, request) => {
        if (!this.registry.resolve(target)) return;
        const key = this.askKey(target, request.requestId);
        this.clearAsk(key);
        if (this.pendingAsks.size >= 64) this.clearAsk(this.pendingAsks.keys().next().value!);
        this.pendingAsks.set(key, { target: { ...target }, request });
        this.emit({ type: "desktop_broker_ask_request", target, request });
      },
      onPlanRequest: (target, request) => {
        if (!this.registry.resolve(target)) return;
        const key = this.planKey(target, request.requestId, request.kind);
        this.clearPlan(key);
        if (this.pendingPlanRequests.size >= 64) this.clearPlan(this.pendingPlanRequests.keys().next().value!);
        this.pendingPlanRequests.set(key, { target: { ...target }, request });
        this.emit({ type: "desktop_broker_plan_request", target, request });
      },
      onPlanResponse: (target, response) => {
        if (response.status !== "cancelled") return;
        const key = this.planKey(target, response.requestId, response.kind);
        const pending = this.pendingPlanRequests.get(key);
        if (!pending || pending.request.kind !== response.kind) return;
        this.clearPlan(key);
        this.emit({ type: "desktop_broker_plan_cancel", target: { ...target }, cancel: { type: "desktop_plan_cancel", requestId: response.requestId, kind: response.kind } });
      },
      onPlanRefine: (target, message) => {
        if (!this.registry.resolve(target)) return;
        const key = this.refineKey(target, message.refineSessionId);
        if (message.type === "desktop_plan_refine_snapshot") {
          this.pendingRefineSnapshots.set(key, { target: { ...target }, message });
        } else if (message.type === "desktop_plan_refine_update") {
          const prior = this.pendingRefineSnapshots.get(key);
          if (prior) {
            const merged = {
              ...prior.message,
              status: message.status,
              sequence: message.sequence,
              turns: message.turn ? [...prior.message.turns, message.turn] : prior.message.turns,
            };
            this.pendingRefineSnapshots.set(key, { target: { ...target }, message: merged });
          }
          if (message.status === "applied" || message.status === "discarded" || message.status === "cancelled") {
            this.pendingRefineSnapshots.delete(key);
          }
        }
        this.emit({ type: "desktop_broker_plan_refine", target: { ...target }, message });
      },
      onAskResponse: (target, response) => {
        if (response.response.cancelled !== true) return;
        const key = this.askKey(target, response.requestId);
        const pending = this.pendingAsks.get(key);
        if (!pending || pending.request.toolCallId !== response.toolCallId) return;
        this.clearAsk(key);
        this.emit({ type: "desktop_broker_ask_cancel", target: { ...target }, response });
      },
    });
  }

  async handlePeerRequest(source: DesktopPluginTarget, request: DesktopPeerRequest): Promise<DesktopPeerResult> {
    const fail = (status: "failed" | "unknown", code: string): DesktopPeerResult => ({ type: "desktop_peer_result", requestId: request.requestId, status, error: { code } });
    if (!isAbsolute(source.normalizedCwd) || normalize(source.normalizedCwd) !== source.normalizedCwd) return fail("failed", "invalid_target");
    if (request.type === "desktop_peer_send" && (!isAbsolute(request.target.normalizedCwd) || normalize(request.target.normalizedCwd) !== request.target.normalizedCwd)) return fail("failed", "invalid_target");
    if (request.deadlineAt <= Date.now() || request.deadlineAt > Date.now() + DESKTOP_PEER_MAX_DEADLINE_MS) return fail("unknown", "deadline_exceeded");
    await this.loadPeerAccess();
    const sourceRegistration = this.registry.resolve(source);
    if (!sourceRegistration?.features?.includes(DESKTOP_PEER_FEATURE)) return fail("failed", "feature_not_negotiated");
    const records = this.registry.snapshotRecords().filter((record) => !this.samePeerTarget(record.target, source));
    if (request.type === "desktop_peer_access_list") {
      const eligible = records.filter((record) => record.features?.includes(DESKTOP_PEER_FEATURE));
      const peers = eligible.slice(0, DESKTOP_PEER_MAX_PEERS).map((record) => record.target);
      return { type: "desktop_peer_result", requestId: request.requestId, status: "access_listed", peers, grants: this.allPeerAccess(), truncated: eligible.length > peers.length };
    }
    if (request.type === "desktop_peer_access_grant") {
      const registration = this.registry.resolve(request.target);
      if (!registration) return fail("unknown", "target_unavailable");
      if (source.normalizedCwd === registration.target.normalizedCwd) return fail("failed", "same_cwd_grant_not_needed");
      const grant: DesktopPeerAccessGrant = { grantId: randomUUID(), sourceCwd: source.normalizedCwd, targetCwd: registration.target.normalizedCwd, direction: request.direction, createdAt: Date.now(), managed: false };
      try {
        await this.changePeerAccess((next) => {
          if (!next.has(this.accessKey(grant.sourceCwd, grant.targetCwd)) && next.size + this.managedPeerAccess.length >= DESKTOP_PEER_MAX_PEERS) throw new Error("peer_access_limit");
          next.set(this.accessKey(grant.sourceCwd, grant.targetCwd), grant);
        });
      } catch (error) { return fail("failed", error instanceof Error && error.message === "peer_access_limit" ? "peer_access_limit" : "peer_access_persist_failed"); }
      return { type: "desktop_peer_result", requestId: request.requestId, status: "access_granted", grant };
    }
    if (request.type === "desktop_peer_access_revoke") {
      if (this.managedPeerAccess.some((grant) => grant.grantId === request.grantId)) return fail("failed", "managed_grant");
      try {
        await this.changePeerAccess((next) => {
          const entry = [...next.entries()].find(([, grant]) => grant.grantId === request.grantId);
          if (!entry) throw new Error("grant_not_found");
          if (entry[1].sourceCwd !== source.normalizedCwd) throw new Error("grant_not_owned");
          next.delete(entry[0]);
        });
      } catch (error) {
        const code = error instanceof Error && ["grant_not_found", "grant_not_owned"].includes(error.message) ? error.message : "peer_access_persist_failed";
        return fail("failed", code);
      }
      for (const pending of this.pendingPeerSends.values()) if (!this.peerAuthorized(pending.source, pending.target)) pending.controller.abort();
      return { type: "desktop_peer_result", requestId: request.requestId, status: "access_revoked", grantId: request.grantId };
    }
    if (request.type === "desktop_peer_list") {
      const eligible = records.filter((record) => this.peerAuthorized(source, record.target) && record.features?.includes(DESKTOP_PEER_FEATURE));
      const peers = eligible.slice(0, DESKTOP_PEER_MAX_PEERS).map((record) => record.target);
      return { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers, truncated: eligible.length > peers.length };
    }
    if (Buffer.byteLength(request.message, "utf8") > DESKTOP_PEER_MAX_MESSAGE_BYTES) return fail("failed", "message_too_large");
    if (!isAbsolute(request.target.normalizedCwd) || normalize(request.target.normalizedCwd) !== request.target.normalizedCwd) return fail("failed", "invalid_target");
    const registration = this.registry.resolve(request.target);
    if (!registration) return fail("unknown", "target_unavailable");
    if (source.normalizedCwd !== registration.target.normalizedCwd && !this.peerAuthorized(source, registration.target)) {
      return { ...fail("failed", "authorization_required"), authorization: { sourceCwd: source.normalizedCwd, targetCwd: registration.target.normalizedCwd } };
    }
    if (!registration.features?.includes(DESKTOP_PEER_FEATURE) || !registration.transport.deliverPeerMessage) return fail("failed", "feature_not_negotiated");
    const key = JSON.stringify([source.sessionId, source.endpointId, source.normalizedCwd, source.processGeneration, request.requestId]);
    for (const [completedKey, completed] of this.completedPeerRequests) if (completed.expiresAt <= Date.now()) this.completedPeerRequests.delete(completedKey);
    const completed = this.completedPeerRequests.get(key);
    if (completed) return completed.result;
    if (this.pendingPeerSends.has(key)) return fail("failed", "duplicate_request");
    const controller = new AbortController();
    this.pendingPeerSends.set(key, { source, target: request.target, controller });
    const deliveryId = randomUUID();
    const delivery: DesktopPeerDelivery = { type: "desktop_peer_delivery", requestId: request.requestId, deliveryId, source: { ...source }, target: { ...registration.target }, deadlineAt: request.deadlineAt, message: request.message };
    try {
      const status = await registration.transport.deliverPeerMessage(delivery, controller.signal);
      if (controller.signal.aborted || !this.peerAuthorized(source, registration.target)) return fail("failed", "authorization_required");
      if (this.registry.resolve(source)?.transport !== sourceRegistration.transport || this.registry.resolve(request.target)?.transport !== registration.transport) return fail("unknown", "disconnected");
      if (Date.now() >= request.deadlineAt) return fail("unknown", "deadline_exceeded");
      const receipt: DesktopPeerResult = { type: "desktop_peer_result", requestId: request.requestId, status, deliveryId };
      if (this.completedPeerRequests.size >= DESKTOP_PEER_MAX_PEERS) this.completedPeerRequests.delete(this.completedPeerRequests.keys().next().value!);
      this.completedPeerRequests.set(key, { result: receipt, expiresAt: Math.min(request.deadlineAt, Date.now() + DESKTOP_PEER_MAX_DEADLINE_MS) });
      return receipt;
    } catch (error) {
      return fail("unknown", error instanceof Error && error.message === "deadline_exceeded" ? "deadline_exceeded" : "disconnected");
    } finally {
      this.pendingPeerSends.delete(key);
    }
  }

  private samePeerTarget(left: DesktopPluginTarget, right: DesktopPluginTarget): boolean {
    return left.sessionId === right.sessionId && left.endpointId === right.endpointId && left.normalizedCwd === right.normalizedCwd && left.processGeneration === right.processGeneration;
  }

  private peerAuthorized(source: DesktopPluginTarget, target: DesktopPluginTarget): boolean {
    if (source.normalizedCwd === target.normalizedCwd) return true;
    if (this.managedPeerAccess.some((grant) => this.grantAllows(grant, source.normalizedCwd, target.normalizedCwd))) return true;
    return [...this.persistentPeerAccess.values()].some((grant) => this.grantAllows(grant, source.normalizedCwd, target.normalizedCwd));
  }

  subscribe(listener: (frame: DesktopBrokerToHostFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.loadPeerAccess();
    await this.pluginServer.start();
  }

  async close(): Promise<void> {
    for (const pending of this.pendingPeerSends.values()) pending.controller.abort();
    this.completedPeerRequests.clear();
    this.unsubscribeRegistry();
    for (const key of this.pendingAsks.keys()) this.clearAsk(key);
    for (const key of this.pendingPlanRequests.keys()) this.clearPlan(key);
    await this.pluginServer.close();
    await this.registry.flush();
    await this.registry.closeStore();
  }

  createSnapshotFrames(): DesktopBrokerToHostFrame[] {
    const revision = this.registry.revision;
    const records = this.registry.snapshotRecords();
    const snapshotId = randomUUID();
    const chunks: DesktopBrokerToHostFrame[] = [];
    for (let index = 0; index < records.length; index += this.snapshotChunkSize) {
      chunks.push({
        type: "desktop_broker_snapshot_chunk",
        brokerInstanceId: this.brokerInstanceId,
        snapshotId,
        revision,
        chunkIndex: chunks.length,
        records: records.slice(index, index + this.snapshotChunkSize),
      });
    }
    return [
      {
        type: "desktop_broker_snapshot_begin",
        brokerInstanceId: this.brokerInstanceId,
        snapshotId,
        revision,
        targetCount: records.length,
      },
      ...chunks,
      {
        type: "desktop_broker_snapshot_end",
        brokerInstanceId: this.brokerInstanceId,
        snapshotId,
        revision,
        chunkCount: chunks.length,
      },
    ];
  }

  async handleHostFrame(frame: DesktopHostToBrokerFrame): Promise<void> {
    switch (frame.type) {
      case "desktop_broker_ready":
        for (const snapshotFrame of this.createSnapshotFrames()) this.emit(snapshotFrame);
        return;
      case "desktop_broker_command":
        await this.forwardCommand(frame.request);
        return;
      case "desktop_broker_ask_response": {
        const registration = this.registry.resolve(frame.target);
        const key = this.askKey(frame.target, frame.response.requestId);
        const pending = this.pendingAsks.get(key);
        const matchingPending = pending?.request.toolCallId === frame.response.toolCallId;
        if (!pending || !matchingPending) {
          this.emitAskResult(frame.target, {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "unknown",
            error: { code: "target_unavailable", message: "desktop ask request unavailable" },
          });
          return;
        }
        if (!registration?.transport.answerAsk) {
          this.emitAskResult(frame.target, {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "unknown",
            error: { code: "target_unavailable", message: "desktop plugin target unavailable" },
          });
          return;
        }
        try {
          const result = await registration.transport.answerAsk(frame.response);
          const askResult: DesktopAskResult = result ?? {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "accepted",
          };
          this.emitAskResult(frame.target, askResult);
          if (askResult.status === "accepted") this.clearAsk(key);
        } catch (error) {
          this.emitAskResult(frame.target, {
            type: "desktop_ask_result",
            requestId: frame.response.requestId,
            toolCallId: frame.response.toolCallId,
            status: "unknown",
            error: { code: "disconnected", message: error instanceof Error ? error.message : "desktop plugin disconnected" },
          });
          return;
        }
        return;
      }
      case "desktop_broker_plan_response": {
        const registration = this.registry.resolve(frame.target);
        const key = this.planKey(frame.target, frame.response.requestId, frame.response.kind);
        const pending = this.pendingPlanRequests.get(key);
        const matchingPending = pending?.request.kind === frame.response.kind;
        if (!pending || !matchingPending) {
          this.emitPlanResult(frame.target, { type: "desktop_plan_result", requestId: frame.response.requestId, kind: frame.response.kind, status: "unknown", error: { code: "target_unavailable" } });
          return;
        }
        if (!registration?.transport.answerPlan) {
          this.emitPlanResult(frame.target, { type: "desktop_plan_result", requestId: frame.response.requestId, kind: frame.response.kind, status: "unknown", error: { code: "target_unavailable" } });
          return;
        }
        try {
          const result = await registration.transport.answerPlan(frame.response);
          this.emitPlanResult(frame.target, result);
          if (result.status === "accepted") this.clearPlan(key);
        } catch {
          this.emitPlanResult(frame.target, { type: "desktop_plan_result", requestId: frame.response.requestId, kind: frame.response.kind, status: "unknown", error: { code: "disconnected" } });
        }
        return;
      }
      case "desktop_broker_plan_refine": {
        const registration = this.registry.resolve(frame.target);
        const message = frame.message;
        if (message.type === "desktop_plan_refine_action") {
          void registration?.transport.answerRefine?.(message).then(() => undefined, () => undefined);
          return;
        }
        if (!registration?.transport.sendRefine) {
          this.emit({ type: "desktop_broker_plan_refine", target: frame.target, message: { ...message, status: "disconnected" } });
          return;
        }
        void registration.transport.sendRefine(message).then((delivered) => {
          if (!delivered) this.emit({ type: "desktop_broker_plan_refine", target: frame.target, message: { ...message, status: "disconnected" } });
        }, () => undefined);
        return;
      }
      case "desktop_broker_ping":
        this.emit({ type: "desktop_broker_pong", nonce: frame.nonce });
        return;
      case "desktop_broker_error":
        return;
    }
  }

  private async forwardCommand(request: Extract<DesktopHostToBrokerFrame, { type: "desktop_broker_command" }>["request"]): Promise<void> {
    const registration = this.registry.resolve(request.target);
    const capability = request.operation.type as DesktopPluginCapability;
    if (!registration || !registration.capabilities.includes(capability)) {
      this.emitCommandResult(request.target, {
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: registration ? "failed" : "unknown",
        error: {
          code: registration ? "capability_mismatch" : "target_unavailable",
          message: registration ? "desktop plugin capability mismatch" : "desktop plugin target unavailable",
        },
      });
      return;
    }
    if (request.deadlineAt <= Date.now()) {
      this.emitCommandResult(request.target, {
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: "unknown",
        error: { code: "deadline_exceeded", message: "desktop plugin deadline exceeded" },
      });
      return;
    }
    try {
      this.emitCommandResult(request.target, await registration.transport.request(request));
    } catch (error) {
      const deadlineExceeded = error instanceof Error && error.message.includes("deadline exceeded");
      this.emitCommandResult(request.target, {
        type: "desktop_plugin_result",
        requestId: request.requestId,
        operation: request.operation.type,
        status: "unknown",
        error: {
          code: deadlineExceeded ? "deadline_exceeded" : "disconnected",
          message: deadlineExceeded ? "desktop plugin deadline exceeded" : "desktop plugin disconnected",
        },
      });
    }
  }

  private clearPlan(key: string): void {
    this.pendingPlanRequests.delete(key);
  }

  private emitPlanResult(target: DesktopPluginTarget, result: DesktopPlanResult): void {
    const frame: DesktopBrokerPlanResult = { type: "desktop_broker_plan_result", target: { ...target }, result };
    this.emit(frame);
  }

  private clearAsk(key: string): void {
    this.pendingAsks.delete(key);
  }

  private emitAskResult(target: DesktopPluginTarget, result: DesktopAskResult): void {
    const frame: DesktopBrokerAskResult = { type: "desktop_broker_ask_result", target: { ...target }, result };
    this.emit(frame);
  }

  private emitCommandResult(target: Extract<DesktopHostToBrokerFrame, { type: "desktop_broker_command" }>["request"]["target"], result: DesktopPluginResult): void {
    this.emit({ type: "desktop_broker_command_result", target, result });
  }

  private emit(frame: DesktopBrokerToHostFrame): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // A disconnected Host must not corrupt Broker-owned state.
      }
    }
  }
}

export interface DesktopBrokerHostClientOptions {
  socketPath: string;
  secret: string;
  maxFrameBytes?: number;
  reconnectDelayMs?: number;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

/** Broker-side client for the Host-owned uplink. Plugin transports remain open across reconnects. */
export class DesktopBrokerHostClient {
  private connection: JsonLineConnection | undefined;
  private inFlightConnection: JsonLineConnection | undefined;
  private unsubscribeBroker: (() => void) | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private closed = false;

  constructor(
    private readonly broker: DesktopBroker,
    private readonly options: DesktopBrokerHostClientOptions,
  ) {}

  start(): void {
    if (this.closed) throw new Error("desktop broker host client is closed");
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.unsubscribeBroker?.();
    this.unsubscribeBroker = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.inFlightConnection?.close();
    this.inFlightConnection = undefined;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.connection) return;
    this.connecting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(this.options.socketPath);
        let ready = false;
        let connection!: JsonLineConnection;
        const fail = (error: Error) => {
          connection.close(error);
          reject(error);
        };
        connection = new JsonLineConnection(
          socket,
          this.options.maxFrameBytes ?? 1024 * 1024,
          (raw) => {
            if (!ready) {
              if (!isDesktopHostToBrokerFrame(raw) || raw.type !== "desktop_broker_ready") {
                fail(new Error("desktop broker host ready required"));
                return;
              }
              if (this.closed) {
                connection.close(new Error("desktop broker host client is closed"));
                reject(new Error("desktop broker host client is closed"));
                return;
              }
              ready = true;
              this.inFlightConnection = undefined;
              this.connection = connection;
              for (const frame of this.broker.createSnapshotFrames()) connection.send(frame);
              for (const frame of this.broker.pendingAskFrames()) connection.send(frame);
              for (const frame of this.broker.pendingPlanFrames()) connection.send(frame);
              for (const frame of this.broker.pendingRefineFrames()) connection.send(frame);
              this.unsubscribeBroker = this.broker.subscribe((frame) => {
                try {
                  connection.send(frame);
                } catch {
                  connection.close(new Error("desktop broker host disconnected"));
                }
              });
              this.options.onConnected?.();
              resolve();
              return;
            }
            if (!isDesktopHostToBrokerFrame(raw)) {
              connection.close(new Error("invalid desktop broker host frame"));
              return;
            }
            void this.broker.handleHostFrame(raw);
          },
          (error) => {
            if (this.inFlightConnection === connection) this.inFlightConnection = undefined;
            if (this.connection === connection) {
              this.connection = undefined;
              this.unsubscribeBroker?.();
              this.unsubscribeBroker = undefined;
              this.options.onDisconnected?.();
            }
            if (!ready) reject(error ?? new Error("desktop broker host disconnected"));
            this.scheduleReconnect();
          },
        );
        this.inFlightConnection = connection;
        socket.once("connect", () => {
          try {
            connection.send({
              type: "desktop_broker_hello",
              protocolVersion: DESKTOP_BROKER_PROTOCOL_VERSION,
              brokerInstanceId: this.broker.brokerInstanceId,
              clientNonce: randomUUID(),
              secret: this.options.secret,
              releaseVersion: MOBILE_RELEASE_VERSION,
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error("desktop broker hello failed"));
          }
        });
        socket.once("error", (error) => {
          if (!ready) reject(error);
        });
      });
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || this.connection) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.options.reconnectDelayMs ?? 500);
  }
}

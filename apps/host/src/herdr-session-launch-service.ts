import { randomUUID } from "node:crypto";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import { HerdrAdapter, HerdrAdapterError, type HerdrPaneLaunchResult, type HerdrRuntimeProbe, type HerdrServerStatus } from "./herdr-adapter.js";
import type { HerdrLaunchStore, HerdrLaunchedSpaceRecord } from "./herdr-launch-store.js";

export interface HerdrLaunchRegistry {
  readonly epoch: string | undefined;
  readonly isValid: boolean;
  list(): Array<{ target: DesktopPluginTarget; launchNonce?: string }>;
}

export interface HerdrLaunchEvent {
  requestId: string;
  status: "accepted" | "ready" | "failed" | "unknown";
  stage: string;
  paneId?: string;
  target?: DesktopPluginTarget;
  /** auto 解析后实际使用的运行时（ready 时回显） */
  runtime?: "pi" | "pi-bolt";
  error?: { code: string; message: string; source: "command" };
}

/** close_herdr_session 业务结果；帧级 status 恒为 observed */
export interface HerdrCloseEvent {
  requestId: string;
  status: "closed" | "close_timeout" | "herdr_session_busy" | "herdr_session_not_owned";
  paneId?: string;
  workspaceId?: string;
}

export interface HerdrLaunchOptions {
  runtime?: "auto" | "pi" | "pi-bolt";
  resumeSessionRef?: string;
}

interface PendingLaunch {
  promise: Promise<HerdrLaunchEvent>;
  createdAt: number;
}

const PENDING_TTL_MS = 5 * 60_000;
const REGISTRATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export class HerdrSessionLaunchService {
  private readonly pending = new Map<string, PendingLaunch>();

  constructor(
    private readonly registry: HerdrLaunchRegistry,
    private readonly adapter = new HerdrAdapter(),
    private readonly store?: HerdrLaunchStore,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async status(): Promise<HerdrServerStatus> {
    return this.adapter.probe();
  }

  async runtimes(): Promise<HerdrRuntimeProbe> {
    return this.adapter.probeRuntimes();
  }

  /** 启动时对账：登记项中已不存在的 pane 剔除并写回。 */
  async reconcileLaunchedSpaces(): Promise<number> {
    if (!this.store) return 0;
    let removed = 0;
    try {
      const live = new Set((await this.adapter.listPanes()).map((pane) => pane.paneId));
      for (const record of await this.store.listLaunches()) {
        if (live.has(record.paneId)) continue;
        await this.store.removeLaunch(record.paneId);
        removed += 1;
      }
    } catch {
      // Herdr 不可用时保留登记项，等下次对账。
    }
    return removed;
  }

  async launch(requestId: string, cwd: string, label?: string, options: HerdrLaunchOptions = {}): Promise<HerdrLaunchEvent> {
    this.prune();
    const existing = this.pending.get(requestId);
    if (existing) return existing.promise;
    const promise = this.performLaunch(requestId, cwd, label, options);
    this.pending.set(requestId, { promise, createdAt: this.now() });
    const result = await promise;
    if (result.status === "ready" || result.status === "failed") this.pending.set(requestId, { promise: Promise.resolve(result), createdAt: this.now() });
    return result;
  }

  async close(requestId: string, target: DesktopPluginTarget): Promise<HerdrCloseEvent> {
    if (!this.store) return { requestId, status: "herdr_session_not_owned" };
    const record = (await this.store.listLaunches()).find((entry) => sameTarget(entry.target, target));
    if (!record) return { requestId, status: "herdr_session_not_owned" };
    if (this.isBusy(target)) return { requestId, status: "herdr_session_busy", paneId: record.paneId };

    try {
      await this.adapter.sendCtrlD(record.paneId);
    } catch (error) {
      // 发送失败视为本次未生效；保留登记允许重试。
      return { requestId, status: "close_timeout", paneId: record.paneId, workspaceId: record.workspaceId, ...(errorBody(error)) };
    }

    const deadline = this.now() + CLOSE_TIMEOUT_MS;
    while (this.now() < deadline) {
      const stillRegistered = this.registry.list().some((registration) => sameTarget(registration.target, target));
      if (!stillRegistered) {
        await this.store.removeLaunch(record.paneId);
        await this.cleanupSpace(record);
        return { requestId, status: "closed", paneId: record.paneId, workspaceId: record.workspaceId };
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
    // 超时保留登记项，允许重试。
    return { requestId, status: "close_timeout", paneId: record.paneId, workspaceId: record.workspaceId };
  }

  async closeAll(): Promise<number> {
    if (!this.store) return 0;
    let closed = 0;
    for (const record of await this.store.listLaunches()) {
      const result = await this.close(randomUUID(), record.target);
      if (result.status === "closed") closed += 1;
    }
    return closed;
  }

  private isBusy(target: DesktopPluginTarget): boolean {
    const match = this.registry.list().find((registration) => sameTarget(registration.target, target));
    return match !== undefined && (match as { runtimeStatus?: string }).runtimeStatus === "running";
  }

  private async cleanupSpace(record: HerdrLaunchedSpaceRecord): Promise<void> {
    if (!this.store || !record.workspaceId) return;
    let data: { settings: { autoCleanupSpace: boolean } };
    try {
      data = await this.store.read();
    } catch {
      return;
    }
    if (!data.settings.autoCleanupSpace) return;
    try {
      const live = await this.adapter.listPanes();
      if (live.some((pane) => pane.workspaceId === record.workspaceId)) return;
      await this.adapter.closeWorkspace(record.workspaceId);
    } catch {
      // 清理失败不阻塞关闭结果；空间留给下次对账或手动处理。
    }
  }

  private async performLaunch(requestId: string, cwd: string, label: string | undefined, options: HerdrLaunchOptions): Promise<HerdrLaunchEvent> {
    const expectedEpoch = this.registry.epoch;
    if (!this.registry.isValid || !expectedEpoch) {
      return { requestId, status: "unknown", stage: "broker_projection_unavailable" };
    }
    try {
      const runtime = await this.resolveRuntime(options.runtime);
      const launched = await this.adapter.launchPiPane({
        requestId,
        cwd,
        label,
        ...(options.resumeSessionRef !== undefined ? { resumeSessionRef: options.resumeSessionRef } : {}),
        ...(runtime !== "auto" ? { runtime } : {}),
      });
      const deadline = this.now() + REGISTRATION_TIMEOUT_MS;
      while (this.now() < deadline) {
        if (!this.registry.isValid || this.registry.epoch !== expectedEpoch) {
          return { requestId, status: "unknown", stage: "broker_epoch_changed", paneId: launched.paneId };
        }
        const matches = this.registry.list().filter((registration) => registration.launchNonce === launched.launchNonce);
        if (matches.length > 1) return { requestId, status: "failed", stage: "plugin_registered", paneId: launched.paneId, error: { code: "launch_nonce_ambiguous", message: "Multiple Pi sessions reported the launch nonce", source: "command" } };
        const match = matches[0];
        if (match) {
          const expectedCwd = await import("node:fs/promises").then(({ realpath }) => realpath(cwd));
          if (match.target.normalizedCwd !== expectedCwd) return { requestId, status: "failed", stage: "plugin_registered", paneId: launched.paneId, error: { code: "launch_target_mismatch", message: "Registered Pi cwd does not match the requested cwd", source: "command" } };
          await this.recordLaunchedSpace(launched, match.target, cwd, label);
          return {
            requestId,
            status: "ready",
            stage: "ready",
            paneId: launched.paneId,
            target: { ...match.target },
            ...(runtime === "auto" ? await this.echoAutoRuntime() : { runtime }),
          };
        }
        await this.sleep(POLL_INTERVAL_MS);
      }
      return { requestId, status: "unknown", stage: "registration_timeout", paneId: launched.paneId, error: { code: "registration_timeout", message: "Pi started but did not register before the deadline", source: "command" } };
    } catch (error) {
      if (error instanceof HerdrAdapterError) {
        const sideEffectMayHaveOccurred = error.stage === "create_pane" || error.stage === "start_pi";
        return {
          requestId,
          status: sideEffectMayHaveOccurred ? "unknown" : "failed",
          stage: sideEffectMayHaveOccurred ? `${error.stage}_outcome_unknown` : error.stage,
          error: {
            code: sideEffectMayHaveOccurred ? "herdr_operation_outcome_unknown" : error.code,
            message: error.message,
            source: "command",
          },
        };
      }
      return { requestId, status: "unknown", stage: "outcome_unknown", error: { code: "herdr_operation_failed", message: error instanceof Error ? error.message.slice(0, 256) : "Herdr launch failed", source: "command" } };
    }
  }

  /** auto：探测到 pi-bolt 用 pi-bolt，否则 pi。 */
  private async resolveRuntime(runtime: HerdrLaunchOptions["runtime"]): Promise<"auto" | "pi" | "pi-bolt"> {
    if (runtime === "pi" || runtime === "pi-bolt") return runtime;
    return "auto";
  }

  private async echoAutoRuntime(): Promise<{ runtime: "pi" | "pi-bolt" }> {
    try {
      const probe = await this.adapter.probeRuntimes();
      return { runtime: probe.piBolt ? "pi-bolt" : "pi" };
    } catch {
      return { runtime: "pi" };
    }
  }

  private async recordLaunchedSpace(launched: HerdrPaneLaunchResult, target: DesktopPluginTarget, cwd: string, label: string | undefined): Promise<void> {
    if (!this.store) return;
    const record: HerdrLaunchedSpaceRecord = {
      paneId: launched.paneId,
      target: { ...target },
      cwd,
      launchedAt: new Date(this.now()).toISOString(),
      ...(launched.workspaceId !== undefined ? { workspaceId: launched.workspaceId } : {}),
      ...(label !== undefined ? { label } : {}),
    };
    try {
      await this.store.recordLaunch(record);
    } catch {
      // 登记失败不阻断 ready；close 会以 not_owned 拒绝，属于可观察的降级。
    }
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [id, value] of this.pending) if (value.createdAt < cutoff) this.pending.delete(id);
  }
}

function sameTarget(left: DesktopPluginTarget, right: DesktopPluginTarget): boolean {
  return left.sessionId === right.sessionId && left.endpointId === right.endpointId
    && left.normalizedCwd === right.normalizedCwd && left.processGeneration === right.processGeneration;
}

function errorBody(error: unknown): { error: { code: string; message: string; source: "command" } } {
  return {
    error: {
      code: "herdr_operation_failed",
      message: error instanceof Error ? error.message.slice(0, 256) : "Herdr command failed",
      source: "command",
    },
  };
}

export function newHerdrLaunchRequestId(): string {
  return randomUUID();
}

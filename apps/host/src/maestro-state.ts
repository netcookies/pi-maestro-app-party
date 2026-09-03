/**
 * MaestroStateReader — 只读读取 flow-schedule store 文件，投影为移动端友好类型
 *
 * 不依赖 pi-maestro-flow 的 store 类（避免进程内锁竞争），直接读文件快照。
 * store 文件路径：<projectRoot>/.pi/flow-schedule/v1/schedules/<id>.json
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type {
  MaestroScheduleSummary,
  MaestroScheduleState,
  MaestroStepSummary,
  MaestroDispatchSummary,
  MaestroDispatchState,
  MaestroState,
} from "@maestro-mobile/shared";

const FLOW_SCHEDULE_DIR = ".pi/flow-schedule/v1";
const SCHEDULES_DIR = "schedules";
const DISPATCHES_DIR = "dispatches";
const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB

export interface MaestroReaderOptions {
  /** 项目根路径，默认 process.cwd() */
  projectRoot?: string;
  /** 轮询间隔 ms，默认 5000 */
  pollIntervalMs?: number;
}

export class MaestroStateReader {
  private readonly projectRoot: string;
  private readonly schedulesDir: string;
  private readonly dispatchesDir: string;
  private lastReadAt = 0;

  constructor(options: MaestroReaderOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.schedulesDir = join(this.projectRoot, FLOW_SCHEDULE_DIR, SCHEDULES_DIR);
    this.dispatchesDir = join(this.projectRoot, FLOW_SCHEDULE_DIR, DISPATCHES_DIR);
  }

  get root(): string {
    return this.projectRoot;
  }

  /** 检测 flow-schedule 目录是否存在（判断是否安装了 pi-maestro-flow） */
  async detectMaestro(): Promise<boolean> {
    try {
      const dir = join(this.projectRoot, FLOW_SCHEDULE_DIR);
      const s = await stat(dir);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /** 读取所有活跃的调度快照 */
  async readState(): Promise<MaestroState> {
    const schedules = await this.readAllSchedules();
    return {
      schedules,
      observedAt: new Date().toISOString(),
    };
  }

  private async readAllSchedules(): Promise<MaestroScheduleSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.schedulesDir);
    } catch {
      return [];
    }

    const results: MaestroScheduleSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const scheduleId = entry.slice(0, -5);
      const summary = await this.readSchedule(scheduleId);
      if (summary) results.push(summary);
    }
    return results.sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
  }

  private async readSchedule(scheduleId: string): Promise<MaestroScheduleSummary | undefined> {
    const filePath = join(this.schedulesDir, `${scheduleId}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.length > MAX_FILE_SIZE) return undefined;
      const record = JSON.parse(raw) as Record<string, unknown>;

      const steps = record.steps as Record<string, Record<string, unknown>> | undefined;
      const stepIds = (record.stepIds as string[]) ?? Object.keys(steps ?? {});
      const stepSummaries: MaestroStepSummary[] = [];

      let completedCount = 0;
      let totalCount = stepIds.length;

      for (const stepId of stepIds) {
        const step = steps?.[stepId] as Record<string, unknown> | undefined;
        const stepState = String(step?.state ?? "pending");
        const dispatchIds = (step?.attempts as string[]) ?? [];
        const dispatches = await this.readDispatches(dispatchIds, scheduleId);
        const isDone = stepState === "completed" || stepState === "failed" || stepState === "cancelled";
        if (isDone) completedCount++;

        stepSummaries.push({
          stepId,
          title: String(step?.prompt ?? "").slice(0, 80),
          state: stepState,
          dispatches,
        });
      }

      const state = this.normalizeScheduleState(String(record.state ?? "draft"));

      const targetIdentity = record.targetIdentity as Record<string, string> | undefined;
      const id = targetIdentity
        ? {
            workspaceId: String(targetIdentity.workspaceId ?? ""),
            ownerId: String(targetIdentity.ownerId ?? ""),
            endpointId: String(targetIdentity.endpointId ?? ""),
          }
        : undefined;

      return {
        scheduleId,
        title: String(record.reason ?? record.scheduleId ?? ""),
        state,
        progress: { completed: completedCount, total: totalCount },
        steps: stepSummaries,
        createdAt: new Date(Number(record.createdAt) ?? 0).toISOString(),
        updatedAt: new Date(Number(record.updatedAt) ?? 0).toISOString(),
        targetIdentity: id,
      };
    } catch {
      return undefined;
    }
  }

  private async readDispatches(dispatchIds: string[], scheduleId: string): Promise<MaestroDispatchSummary[]> {
    const results: MaestroDispatchSummary[] = [];
    for (const dispatchId of dispatchIds) {
      const summary = await this.readDispatch(dispatchId, scheduleId);
      if (summary) results.push(summary);
    }
    return results;
  }

  private async readDispatch(dispatchId: string, scheduleId: string): Promise<MaestroDispatchSummary | undefined> {
    const dir = join(this.dispatchesDir, dispatchId);
    try {
      const intentPath = join(dir, "intent.json");
      const completionPath = join(dir, "completion.json");

      let state: MaestroDispatchState = "prepared";
      let completedAt: string | undefined;
      let error: string | undefined;
      let resultSummary: string | undefined;

      // 检查 completion 文件
      try {
        const completionRaw = await readFile(completionPath, "utf8");
        const completion = JSON.parse(completionRaw) as Record<string, unknown>;
        state = String(completion.outcome ?? "completed") as MaestroDispatchState;
        if (state === "failed" || state === "timeout") {
          error = String(completion.summary ?? "Unknown error");
        }
        resultSummary = String(completion.summary ?? "");
        completedAt = new Date(Number(completion.settledAt ?? completion.createdAt ?? 0)).toISOString();
      } catch {
        // 检查 published 文件
        try {
          await stat(join(dir, "published.json"));
          state = "published";
        } catch {
          // 检查 accepted 文件
          try {
            await stat(join(dir, "accepted.json"));
            state = "accepted";
          } catch {
            state = "prepared";
          }
        }
      }

      // 读取 intent 获取 agent / task 信息
      let agent: string | undefined;
      let task: string | undefined;
      try {
        const intentRaw = await readFile(intentPath, "utf8");
        const intent = JSON.parse(intentRaw) as Record<string, unknown>;
        agent = String(intent.agent ?? intent.targetSelector ?? "");
        task = String(intent.instruction ?? "").slice(0, 120);
      } catch {
        // ignore
      }

      return {
        dispatchId,
        state,
        agent,
        task,
        startedAt: undefined,
        completedAt,
        resultSummary,
        error,
        attempt: 0,
      };
    } catch {
      return undefined;
    }
  }

  private normalizeScheduleState(raw: string): MaestroScheduleState {
    switch (raw) {
      case "draft":
      case "active":
      case "paused":
      case "completed":
      case "failed":
      case "cancelled":
        return raw;
      default:
        return "draft";
    }
  }
}
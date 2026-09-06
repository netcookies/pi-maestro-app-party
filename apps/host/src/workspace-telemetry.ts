/**
 * WorkspaceTelemetry — 读取 pi-maestro-teammate workspace-peer 运行时状态
 *
 * 合同（pi-maestro-teammate 持久化）：
 *   ~/.pi/teammate/workspaces/<workspaceId>/runtime/owners/<ownerId>.json
 *     { workspaceId, normalizedCwd, ownerId, pid, sessionId, publishedAt,
 *       contextPressure, agents[], settled[], backgroundJobs[] }
 *   ~/.pi/teammate/workspaces/<id>/runtime/identities/claims/<key>.heartbeat.json
 *
 * 语义：
 *  - 每个 owner = 一个活的 Pi 会话（workspace owner claim 持有者）
 *  - heartbeat 新鲜度 = 会话是否活跃
 *  - agents[] = 正在运行的子 agent（teammate dispatch）
 *  - backgroundJobs[] = 后台任务
 *
 * 这正是 Monitor/Teammate Tab 需要的"窗口状态"合同。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WorkspaceOwnerState, WorkspaceTelemetryState, JsonValue } from "@maestro-mobile/shared";

/** 兼容别名：投影层使用 shared 类型（单一来源） */
export type WorkspaceOwner = WorkspaceOwnerState;
export type WorkspaceTelemetry = WorkspaceTelemetryState;

const WORKSPACES_ROOT = join(homedir(), ".pi", "teammate", "workspaces");
const HEARTBEAT_STALE_MS = 90_000; // 90s 无心跳视为不活跃

export class WorkspaceTelemetryReader {
  constructor(private readonly staleMs = HEARTBEAT_STALE_MS) {}

  async read(): Promise<WorkspaceTelemetry> {
    const owners: WorkspaceOwner[] = [];
    let wsDirs: string[] = [];
    try {
      wsDirs = await readdir(WORKSPACES_ROOT);
    } catch {
      return { owners: [], observedAt: new Date().toISOString(), aliveCount: 0 };
    }

    for (const wsId of wsDirs) {
      const ownersDir = join(WORKSPACES_ROOT, wsId, "runtime", "owners");
      let files: string[];
      try {
        files = await readdir(ownersDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json") || f.includes(".tmp")) continue;
        try {
          const raw = await readFile(join(ownersDir, f), "utf8");
          const d = JSON.parse(raw) as Record<string, unknown>;
          if (d.kind !== "owner") continue;
          // 畸形 publishedAt 跳过：NaN 会让 alive/排序失效（correctness）
          const publishedAt = Number(d.publishedAt);
          if (!Number.isFinite(publishedAt) || publishedAt <= 0) continue;
          const ageMs = Math.max(0, Date.now() - publishedAt);
          owners.push({
            workspaceId: String(d.workspaceId ?? wsId),
            normalizedCwd: String(d.normalizedCwd ?? ""),
            ownerId: String(d.ownerId ?? ""),
            pid: Number(d.pid ?? 0),
            sessionId: String(d.sessionId ?? ""),
            publishedAt,
            contextPressure: (d.contextPressure ?? null) as JsonValue,
            agents: Array.isArray(d.agents) ? (d.agents as JsonValue[]) : [],
            settled: Array.isArray(d.settled) ? (d.settled as JsonValue[]) : [],
            backgroundJobs: Array.isArray(d.backgroundJobs) ? (d.backgroundJobs as JsonValue[]) : [],
            alive: ageMs < this.staleMs,
            ageMs,
          });
        } catch {
          // skip malformed
        }
      }
    }

    owners.sort((a, b) => b.publishedAt - a.publishedAt);
    const aliveCount = owners.filter((o) => o.alive).length;
    return { owners, observedAt: new Date().toISOString(), aliveCount };
  }
}
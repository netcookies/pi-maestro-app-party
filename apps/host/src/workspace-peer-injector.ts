/**
 * WorkspacePeerInjector — 将手机端消息跨进程注入到当前桌面 TUI 的信箱
 *
 * 机制：
 * 桌面 TUI 窗口加载了 pi-maestro-teammate 插件，常驻轮询自己的命令信箱：
 * ~/.pi/teammate/workspaces/<workspaceId>/runtime/commands/<ownerId>/<commandId>.json
 *
 * 当手机发 prompt 时，若检测到桌面 TUI 正开着该工作区：
 * 1. 本模块往信箱原子写入一条 action: "steer" 命令；
 * 2. 桌面 TUI 瞬间感应，终端屏幕上立刻打印该消息并启动大模型回答；
 * 3. 随后桌面 TUI 写入 JSONL，由 JsonlTailWatcher 实时捕获流式推回手机端；
 * 4. 实现真正的“手机说话，电脑 TUI 跟着动；电脑打字，手机实时看”的双端同屏协同！
 */
import { writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { WorkspaceOwner } from "./workspace-telemetry.js";

const WORKSPACES_ROOT = join(homedir(), ".pi", "teammate", "workspaces");

export interface WorkspacePeerCommandPayload {
  version: 1;
  kind: "command";
  workspaceId: string;
  commandId: string;
  fromOwnerId: string;
  fromOwnerNonce: string;
  toOwnerId: string;
  toOwnerNonce: string;
  targetCorrelationId: string;
  action: "steer";
  message: string;
  source: "monitor";
  createdAt: number;
  expiresAt: number;
}

export async function injectMessageToActiveTui(
  owner: WorkspaceOwner,
  message: string,
): Promise<boolean> {
  if (!owner.alive || !owner.workspaceId || !owner.ownerId) {
    return false;
  }

  // 必须拥有 ownerNonce 才能通过目标端的消息校验
  const ownerNonce = owner.ownerNonce;
  if (!ownerNonce) {
    return false;
  }

  const mailboxDir = join(WORKSPACES_ROOT, owner.workspaceId, "runtime", "commands", owner.ownerId);

  try {
    await mkdir(mailboxDir, { recursive: true });
    const commandId = randomBytes(16).toString("hex");
    const fromOwnerId = randomBytes(16).toString("hex");
    const fromOwnerNonce = randomBytes(16).toString("hex");
    const now = Date.now();

    const command: WorkspacePeerCommandPayload = {
      version: 1,
      kind: "command",
      workspaceId: owner.workspaceId,
      commandId,
      fromOwnerId,
      fromOwnerNonce,
      toOwnerId: owner.ownerId,
      toOwnerNonce: ownerNonce,
      targetCorrelationId: "window-main-session",
      action: "steer",
      message,
      source: "monitor",
      createdAt: now,
      expiresAt: now + 60_000,
    };

    // 原子写入：先写临时文件再 rename，防止对方进程读到空或截断的 JSON
    const tmpFile = join(mailboxDir, `${commandId}.tmp`);
    const targetFile = join(mailboxDir, `${commandId}.json`);

    await writeFile(tmpFile, JSON.stringify(command, null, 2) + "\n", { mode: 0o600 });
    await rename(tmpFile, targetFile);
    return true;
  } catch (error) {
    console.warn(`[maestro-mobile] injectMessageToActiveTui failed for owner=${owner.ownerId}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

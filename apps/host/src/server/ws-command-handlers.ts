/**
 * ws-command-handlers — MobileHostServer 的 WS 命令处理表
 *
 * 每个命令一个独立 handler（H9 拆分）：签名统一 (ctx, command) => result。
 * ctx 提供 controller / sendError 等最小依赖，handler 不直接依赖 server 内部。
 * 新增命令只需在 HANDLERS 表加一项，不再改 600 行 switch。
 */
import type { HostController } from "../host-controller.js";
import { projectMonitorState } from "../monitor-projection.js";
import { readSettingsOverview, updateSettingsJson } from "../maestro-settings.js";
import { toSdkImageContent, listSkills, HostSessionListService } from "./helpers.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientCommand, ExtensionUiResponse } from "@maestro-mobile/shared";

export interface CommandContext {
  controller: HostController;
  hostSessionList?: HostSessionListService;
  /** 某些命令（get_snapshot）需要直接写 WS 帧 */
  sendFrame: (payload: unknown) => void;
}

type CommandHandler<C = ClientCommand> = (
  ctx: CommandContext,
  command: C,
) => Promise<unknown> | unknown;

/** runner 查找 + 未找到时抛带 code 的错误（统一 session_not_found 语义） */
function requireSession(ctx: CommandContext, sessionId: string): NonNullable<ReturnType<HostController["getSession"]>> {
  const runner = ctx.controller.getSession(sessionId);
  if (!runner) {
    const err = new Error("session_not_found") as Error & { code?: string };
    err.code = "session_not_found";
    throw err;
  }
  return runner;
}

function optionalRunnerFn<R>(runner: unknown, name: string, fallback: R): R {
  const fn = (runner as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as () => R)() : fallback;
}

export const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  list_live_sessions: (ctx) => ctx.controller.listLiveSessions(),

  load_more_history: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    return runner.loadMoreHistory((cmd as { count: number }).count);
  },

  search_history: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const c = cmd as { keyword: string; maxResults?: number; previewLength?: number };
    return runner.searchHistory(c.keyword, c.maxResults, c.previewLength);
  },

  list_models: (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    return optionalRunnerFn(runner, "listModels", []);
  },

  list_skills: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const loaded = optionalRunnerFn<unknown[]>(runner, "listLoadedSkills", []);
    const skills = loaded.length > 0 ? loaded : await listSkills(runner.state.cwd);
    return skills;
  },

  get_maestro_settings: () => readSettingsOverview(),

  update_maestro_settings: async (_ctx, cmd) => {
    const c = cmd as { key: string; patch: Record<string, unknown> };
    if (c.key !== "settings") {
      const err = new Error("unsupported_key") as Error & { code?: string };
      err.code = "unsupported_key";
      throw err;
    }
    return updateSettingsJson(c.patch);
  },

  set_model: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const fn = (runner as unknown as Record<string, unknown>).setModel;
    if (typeof fn !== "function") {
      const err = new Error("unsupported_command") as Error & { code?: string };
      err.code = "unsupported_command";
      throw err;
    }
    return (fn as (modelId: string) => unknown).call(runner, (cmd as { modelId: string }).modelId);
  },

  set_thinking: (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const fn = (runner as unknown as Record<string, unknown>).setThinking;
    if (typeof fn !== "function") {
      const err = new Error("unsupported_command") as Error & { code?: string };
      err.code = "unsupported_command";
      throw err;
    }
    return (fn as (level: string) => unknown).call(runner, (cmd as { level: string }).level);
  },

  compact: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const fn = (runner as unknown as Record<string, unknown>).compact;
    if (typeof fn !== "function") {
      const err = new Error("unsupported_command") as Error & { code?: string };
      err.code = "unsupported_command";
      throw err;
    }
    return (fn as (i?: string) => unknown).call(runner, (cmd as { customInstructions?: string }).customInstructions);
  },

  rename_session: (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const fn = (runner as unknown as Record<string, unknown>).renameSession;
    if (typeof fn !== "function") {
      const err = new Error("unsupported_command") as Error & { code?: string };
      err.code = "unsupported_command";
      throw err;
    }
    return (fn as (name: string) => unknown).call(runner, (cmd as { name: string }).name);
  },

  list_host_sessions: async (ctx, cmd) => {
    const c = cmd as { cwd?: string; limit?: number; cursor?: string; query?: string; sessionIds?: string[]; latestForCwds?: string[] };
    const service = ctx.hostSessionList ?? new HostSessionListService({ indexPath: join(homedir(), ".pi", "agent", "mobile-session-index.json") });
    return service.list(() => ctx.controller.listSessions(c.cwd), c);
  },

  open_session: async (ctx, cmd) => {
    const c = cmd as { cwd: string; mode?: "create" | "continue"; sessionFile?: string };
    const runner = await ctx.controller.openSession({ cwd: c.cwd, mode: c.mode, sessionFile: c.sessionFile });
    return { sessionId: runner.id };
  },

  close_session: async (ctx, cmd) => {
    await ctx.controller.closeSession((cmd as { sessionId: string }).sessionId);
    return { closed: true };
  },

  prompt: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const c = cmd as { message: string; images?: { data: string; mime: string }[] };
    const images = c.images?.map((img) => toSdkImageContent(img)).filter((x) => x !== undefined);
    if (c.images && c.images.length > 0 && images?.length !== c.images.length) {
      const err = new Error("images 元素必须是 base64 data 与 mime 字段齐全的图片") as Error & { code?: string };
      err.code = "invalid_image";
      throw err;
    }
    await runner.prompt(c.message, undefined, images);
    return {};
  },

  steer: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    await runner.steer((cmd as { message: string }).message);
    return {};
  },

  steer_window: async (ctx, cmd) => {
    const c = cmd as { endpointId: string; cwd: string; message: string };
    const existing = ctx.controller.getSession(c.endpointId);
    if (existing) {
      await existing.steer(c.message);
      return { ok: true, sessionId: c.endpointId, tookOver: false };
    }
    try {
      const runner = await ctx.controller.openSession({ cwd: c.cwd, mode: "continue", sessionFile: undefined });
      await runner.steer(c.message);
      return { ok: true, sessionId: runner.id, tookOver: true };
    } catch (error) {
      return { ok: false, sessionId: c.endpointId, tookOver: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  follow_up: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    await runner.followUp((cmd as { message: string }).message);
    return {};
  },

  abort: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    await runner.abort();
    return {};
  },

  extension_ui_response: (ctx, cmd) => {
    const c = cmd as { sessionId: string; requestId: string; response: ExtensionUiResponse };
    const ok = ctx.controller.respondToExtensionUi(c.sessionId, c.requestId, c.response);
    if (!ok) {
      const err = new Error("request_not_found") as Error & { code?: string };
      err.code = "request_not_found";
      throw err;
    }
    return {};
  },

  get_maestro_state: (ctx) => ctx.controller.readMaestroStateNow(),

  get_monitor_state: async (ctx) => {
    // 与推送路径共用同一投影，避免双投影漂移
    const telemetry = await ctx.controller.readTelemetry();
    return projectMonitorState(telemetry);
  },

  get_snapshot: (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    return runner.snapshot();
  },

  get_session_usage: async (ctx, cmd) => {
    const runner = requireSession(ctx, (cmd as { sessionId: string }).sessionId);
    const usage = await optionalRunnerFn(runner, "getUsage", { entries: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 });
    const context = optionalRunnerFn(runner, "getContextUsage", null) ?? null;
    return { sessionId: (cmd as { sessionId: string }).sessionId, ...usage, context };
  },
};

// list_skills 的 listSkills / prompt 的 toSdkImageContent 从 helpers 导入

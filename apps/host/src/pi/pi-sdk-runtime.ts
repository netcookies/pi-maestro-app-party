import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { MobileAgentRuntime } from "../mobile-agent.js";
import type { RuntimeFactory } from "../types.js";

export interface OpenSessionRequest {
  cwd: string;
  mode?: "create" | "continue";
  sessionFile?: string;
}

/**
 * PiSdkRuntimeFactory — 通过 Pi SDK 创建 AgentSessionRuntime
 * 与 pi-mobile/apps/host 同源（参考实现），保证与桌面 TUI 共享同一份会话文件
 */
export class PiSdkRuntimeFactory implements RuntimeFactory {
  async createRuntime(request: OpenSessionRequest): Promise<MobileAgentRuntime> {
    const sessionManager = createSessionManager(request);
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager: sm, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        // 过滤不需要的扩展：
        // 1. pi-maestro-teammate：会触发 workspace owner claim 冲突。
        // 2. pi-maestro-mobile 自身：host 进程本身就是服务宿主，通过 SDK 打开会话时
        //    绝不能在无 UI 的子会话内再次加载运行自己的扩展遥控器（会导致 statusCtx.ui 空指针崩溃）。
        resourceLoaderOptions: {
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((e) => !isIgnoredExtension(e.path)),
          }),
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: sm,
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: request.cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });

    return runtime as unknown as MobileAgentRuntime;
  }

  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    return cwd ? SessionManager.list(cwd) : SessionManager.listAll();
  }
}

function createSessionManager(request: OpenSessionRequest): SessionManager {
  if (request.mode === "continue") {
    return SessionManager.continueRecent(request.cwd);
  }
  if (request.sessionFile) {
    return SessionManager.open(request.sessionFile, undefined, request.cwd);
  }
  return SessionManager.create(request.cwd);
}

/** 判断扩展路径是否属于需要被 Host 内部会话忽略的扩展 */
function isIgnoredExtension(path: string): boolean {
  return path.includes("pi-maestro-teammate") || path.includes("pi-maestro-mobile");
}
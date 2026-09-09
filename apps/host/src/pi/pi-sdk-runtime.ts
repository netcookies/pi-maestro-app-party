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
        // 过滤 pi-maestro-teammate：host 进程与真实 Pi 会话共享工作区时
        // 会触发 workspace owner claim 冲突（同一 cwd 只能有一个 live owner）。
        // host 只做只读会话浏览/驱动，不需要 teammate 的 peer 运行时。
        resourceLoaderOptions: {
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((e) => !isTeammateExtension(e.path)),
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

/** 判断扩展路径是否属于 pi-maestro-teammate（其 workspace peer 会与真实 Pi 冲突） */
function isTeammateExtension(path: string): boolean {
  return path.includes("pi-maestro-teammate");
}
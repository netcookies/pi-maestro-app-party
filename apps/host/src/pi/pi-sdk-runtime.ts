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
      const services = await createAgentSessionServices({ cwd });
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
    const sessions = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
    return sessions;
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
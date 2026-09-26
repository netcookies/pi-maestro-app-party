import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SessionCatalog } from "../types.js";

/**
 * 只读持久化会话目录。
 *
 * Host 不再通过 Pi SDK 创建或附着 AgentSession；这里仅复用 SDK 的
 * SessionManager.list() 枚举已有 JSONL 索引，实际内容由 SessionQueryService 读取。
 */
export class PiSessionCatalog implements SessionCatalog {
  constructor(private readonly projectRoot = process.cwd()) {}

  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    return SessionManager.list(cwd ?? this.projectRoot);
  }
}

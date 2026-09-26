import type { HostEvent } from "@maestro-mobile/shared";

export type HostEventListener = (event: HostEvent) => void;

/** Host 只允许通过只读 catalog 枚举已存在的持久化会话。 */
export interface SessionCatalog {
  listSessions(cwd?: string): Promise<unknown[]>;
}

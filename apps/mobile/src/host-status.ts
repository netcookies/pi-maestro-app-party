/**
 * Host 状态元数据解析
 *
 * 协议中 host_status.status 声明为 string，但 Host 首次 WS 连接实际推送的是
 * getStatus() 对象（{ ok, version, maestroDetected, piVersion?, flowVersion?,
 * maestroCliVersion?, sessions, uptimeMs }），之后可能推送 string（如 "session xxx opened"）。
 * 这里把对象载荷安全解析为版本/检测元数据，供设置页「版本与诊断」展示；
 * 解析不出字段时返回 null（UI 显示「待 Host 接入」）。
 */
export interface HostStatusMeta {
  version?: string;
  maestroDetected?: boolean;
  /** Pi coding agent 版本（探测失败时不返回） */
  piVersion?: string;
  /** pi-maestro-flow 扩展版本 */
  flowVersion?: string;
  /** Maestro CLI 版本 */
  maestroCliVersion?: string;
  sessions?: number;
  uptimeMs?: number;
}

export function parseHostStatusMeta(raw: unknown): HostStatusMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: HostStatusMeta = {};
  if (typeof r.version === "string" && r.version.length > 0) out.version = r.version;
  if (typeof r.maestroDetected === "boolean") out.maestroDetected = r.maestroDetected;
  if (typeof r.piVersion === "string" && r.piVersion.length > 0) out.piVersion = r.piVersion;
  if (typeof r.flowVersion === "string" && r.flowVersion.length > 0) out.flowVersion = r.flowVersion;
  if (typeof r.maestroCliVersion === "string" && r.maestroCliVersion.length > 0) out.maestroCliVersion = r.maestroCliVersion;
  if (typeof r.sessions === "number") out.sessions = r.sessions;
  if (typeof r.uptimeMs === "number") out.uptimeMs = r.uptimeMs;
  return Object.keys(out).length > 0 ? out : null;
}

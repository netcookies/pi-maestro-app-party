import type { SessionPresentation } from "@maestro-mobile/shared";
import type { WorkspaceOwner } from "../workspace-telemetry.js";

/**
 * 服务端唯一的 owner 角色/可见性分类。
 * telemetry 的 PID 只作为诊断字段存在，不能赋予控制权；没有 Desktop Plugin
 * 精确 endpoint 时，历史窗口默认只读。
 */
export function isMonitorOwner(owner: WorkspaceOwner): boolean {
  if (owner.sessionName && /control|monitor/i.test(owner.sessionName)) return true;
  if (owner.mainLastSettle && typeof owner.mainLastSettle === "object") {
    const lastResult = String((owner.mainLastSettle as { lastResult?: unknown }).lastResult ?? "");
    return /peer\s+[a-f0-9]{8}|agent-watch|monitor\s+mode|<monitor_mode>/i.test(lastResult);
  }
  return false;
}

export function projectOwnerPresentation(
  owner: WorkspaceOwner,
  monitorWindowCount = 0,
): SessionPresentation {
  const monitor = isMonitorOwner(owner);
  return {
    role: monitor ? "monitor" : "session",
    visibility: monitor ? "monitor_tab" : "session_list",
    control: {
      mode: "readonly",
      canPrompt: false,
      canSteer: false,
      canFollowUp: false,
      canAbort: false,
      canAnswerAsk: false,
    },
    // Owner heartbeat timestamps must not become a presentation revision.
    revision: 0,
    ...(monitor ? { monitorWindowCount } : {}),
  };
}

export function projectOwnerVisibility(owner: WorkspaceOwner): "session_list" | "monitor_tab" {
  return isMonitorOwner(owner) ? "monitor_tab" : "session_list";
}

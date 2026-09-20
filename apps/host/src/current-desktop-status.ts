import type { DesktopPluginRuntimeRecord } from "./plugin/desktop-plugin-runtime-state.js";
import type { DesktopPluginSessionSummary, DesktopPluginTarget } from "@maestro-mobile/shared";

export type DesktopCurrentVerdict =
  | "synced"
  | "drift"
  | "target_missing"
  | "plugin_disconnected"
  | "broker_host_disconnected"
  | "host_unreachable"
  | "broker_flapping";

export type DesktopExpectedAppColor = "green" | "blue" | "warning" | "dim";

export interface DesktopHostDiagnosticTarget {
  target: DesktopPluginTarget;
  runtimeStatus: "running" | "idle";
  summary?: DesktopPluginSessionSummary;
}

export interface DesktopHostDiagnostic {
  broker: {
    connected: boolean;
    projectionValid: boolean;
    brokerInstanceId?: string;
    revision: number;
    flapping?: boolean;
  };
  targets: DesktopHostDiagnosticTarget[];
}

export interface DesktopCurrentStatusReport {
  verdict: DesktopCurrentVerdict;
  expectedAppColor: DesktopExpectedAppColor;
  target?: DesktopPluginTarget;
  local?: DesktopPluginRuntimeRecord;
  host?: DesktopHostDiagnostic;
  hostTarget?: DesktopHostDiagnosticTarget;
  details: string[];
}

export function appColorForRuntimeStatus(status: string | undefined): DesktopExpectedAppColor {
  if (status === "running") return "green";
  if (status === "idle") return "blue";
  if (status === "sleeping") return "warning";
  return "dim";
}

function sameTarget(left: DesktopPluginTarget, right: DesktopPluginTarget): boolean {
  return left.sessionId === right.sessionId
    && left.endpointId === right.endpointId
    && left.normalizedCwd === right.normalizedCwd
    && left.processGeneration === right.processGeneration;
}

export function compareDesktopCurrentStatus(input: {
  target?: DesktopPluginTarget;
  local?: DesktopPluginRuntimeRecord;
  hostReachable: boolean;
  host?: DesktopHostDiagnostic;
}): DesktopCurrentStatusReport {
  const target = input.target ?? input.local?.target;
  const expectedAppColor = appColorForRuntimeStatus(input.local?.localStatus);
  if (!input.hostReachable) {
    return { verdict: "host_unreachable", expectedAppColor, target, local: input.local, details: ["Host HTTP endpoint is unreachable"] };
  }
  if (!input.host) {
    return { verdict: "broker_host_disconnected", expectedAppColor, target, local: input.local, details: ["Host returned no Broker diagnostic"] };
  }
  if (input.host.broker.flapping) {
    return { verdict: "broker_flapping", expectedAppColor, target, local: input.local, host: input.host, details: ["Broker link is repeatedly reconnecting"] };
  }
  if (!input.host.broker.connected || !input.host.broker.projectionValid) {
    return { verdict: "broker_host_disconnected", expectedAppColor, target, local: input.local, host: input.host, details: ["Host projection is not synchronized with Broker"] };
  }
  if (!target) {
    return { verdict: "target_missing", expectedAppColor, local: input.local, host: input.host, details: ["No exact Desktop target is available in this Pi process"] };
  }
  const hostTarget = input.host.targets.find((candidate) => sameTarget(candidate.target, target));
  if (!hostTarget) {
    return { verdict: "target_missing", expectedAppColor, target, local: input.local, host: input.host, details: ["Exact target is absent from Host projection"] };
  }
  if (!input.local) {
    return { verdict: "drift", expectedAppColor, target, host: input.host, hostTarget, details: ["Host has the target but this Pi process has no local runtime record"] };
  }
  if (input.local.pluginBroker !== "connected") {
    return { verdict: "plugin_disconnected", expectedAppColor, target, local: input.local, host: input.host, hostTarget, details: ["Plugin is not connected to Broker"] };
  }
  if (input.local.localStatus !== hostTarget.runtimeStatus) {
    return {
      verdict: "drift",
      expectedAppColor,
      target,
      local: input.local,
      host: input.host,
      hostTarget,
      details: [`Pi local=${input.local.localStatus}, Host projection=${hostTarget.runtimeStatus}`],
    };
  }
  return { verdict: "synced", expectedAppColor, target, local: input.local, host: input.host, hostTarget, details: ["Pi local, Plugin/Broker, Broker/Host, and Host projection agree"] };
}

export function formatDesktopCurrentStatus(report: DesktopCurrentStatusReport): string {
  const target = report.target
    ? `${report.target.sessionId}/${report.target.endpointId} cwd=${report.target.normalizedCwd} generation=${report.target.processGeneration}`
    : "target=none";
  const local = report.local ? `local=${report.local.localStatus}` : "local=missing";
  const plugin = report.local?.pluginBroker ?? "unknown";
  const hostProjection = report.hostTarget?.runtimeStatus ?? "missing";
  const broker = report.host
    ? `broker=${report.host.broker.connected ? "connected" : "disconnected"} epoch=${report.host.broker.brokerInstanceId ?? "none"} revision=${report.host.broker.revision}`
    : "broker=unknown";
  return [
    `maestro-mobile current: ${report.verdict.toUpperCase()} (App expected color: ${report.expectedAppColor})`,
    target,
    `Pi ${local} · Plugin→Broker=${plugin} · Broker→Host projection=${hostProjection}`,
    broker,
    ...report.details,
  ].join("\n");
}

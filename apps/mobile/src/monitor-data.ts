import type { MonitorState, MonitorWindowSummary } from "@maestro-mobile/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept the current Host monitor read envelope while keeping legacy raw state compatible. */
export function monitorStateFromCommandResult(result: unknown): MonitorState {
  const candidate = isRecord(result) && isRecord(result.state) ? result.state : result;
  if (!isRecord(candidate) || !Array.isArray(candidate.windows) || typeof candidate.observedAt !== "string") {
    throw new Error("Invalid monitor state response");
  }
  return candidate as unknown as MonitorState;
}

/** Monitor windows are telemetry projections, not SessionState or exact session targets. */
export function monitorWindows(state: MonitorState | null): MonitorWindowSummary[] {
  return state?.windows ?? [];
}

export function monitorWindowKey(window: MonitorWindowSummary): string {
  const { workspaceId, ownerId, ownerNonce, endpointId } = window.identity;
  return JSON.stringify([workspaceId, ownerId, ownerNonce, endpointId]);
}

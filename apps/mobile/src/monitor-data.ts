import { isExecutionProjection, type ExecutionProjection, type MonitorState, type MonitorWindowSummary } from "@maestro-mobile/shared";

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

export function executionProjectionsFromCommandResult(result: unknown): ExecutionProjection[] {
  if (!isRecord(result) || !Array.isArray(result.projections) || !result.projections.every(isExecutionProjection)) {
    throw new Error("Invalid execution projections response");
  }
  return result.projections;
}


export function monitorWindows(state: MonitorState | null): MonitorWindowSummary[] {
  return state?.windows ?? [];
}

export function monitorWindowKey(window: MonitorWindowSummary): string {
  const { workspaceId, ownerId, ownerNonce, endpointId } = window.identity;
  return JSON.stringify([workspaceId, ownerId, ownerNonce, endpointId]);
}

import type { MonitorState, WorkspaceTelemetryState } from "@maestro-mobile/shared";
import { projectMonitorState, telemetryStableKey } from "../monitor-projection.js";
import type { WorkspaceTelemetryReader } from "../workspace-telemetry.js";

export interface MonitorReadSnapshot {
  state: MonitorState;
  stableKey: string;
  revision: number;
}

export type MonitorTelemetrySource = Pick<WorkspaceTelemetryReader, "read"> | (() => Promise<WorkspaceTelemetryState>);

/**
 * Read-only Monitor query service. Both pull and push callers consume the same
 * bounded projection and the same revision/stable-key state machine.
 */
export class MonitorReadService {
  private lastStableKey: string | undefined;
  private revision = 0;

  constructor(private readonly source: MonitorTelemetrySource) {}

  async read(): Promise<MonitorReadSnapshot> {
    const telemetry = typeof this.source === "function"
      ? await this.source()
      : await this.source.read();
    const state = projectMonitorState(telemetry);
    const stableKey = telemetryStableKey(telemetry);
    if (stableKey !== this.lastStableKey) {
      this.lastStableKey = stableKey;
      this.revision += 1;
    }
    return {
      state: { ...state, revision: this.revision },
      stableKey,
      revision: this.revision,
    };
  }
}

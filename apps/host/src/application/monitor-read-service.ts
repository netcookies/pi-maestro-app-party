import type { MonitorState, WorkspaceTelemetryState } from "@maestro-mobile/shared";
import { projectMonitorWindows, telemetryStableKeyFromWindows } from "../monitor-projection.js";
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

  private readChain: Promise<void> = Promise.resolve();

  constructor(private readonly source: MonitorTelemetrySource) {}

  async read(): Promise<MonitorReadSnapshot> {
    let resolveResult!: (value: MonitorReadSnapshot) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<MonitorReadSnapshot>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = this.readChain.then(async () => {
      try {
        const telemetry = typeof this.source === "function"
          ? await this.source()
          : await this.source.read();
        const windows = projectMonitorWindows(telemetry);
        const state = { windows, observedAt: telemetry.observedAt };
        const stableKey = telemetryStableKeyFromWindows(windows);
        if (stableKey !== this.lastStableKey) {
          this.lastStableKey = stableKey;
          this.revision += 1;
        }
        resolveResult({
          state: { ...state, revision: this.revision },
          stableKey,
          revision: this.revision,
        });
      } catch (error) {
        rejectResult(error);
      }
    });
    this.readChain = run.then(() => undefined, () => undefined);
    return result;
  }
}

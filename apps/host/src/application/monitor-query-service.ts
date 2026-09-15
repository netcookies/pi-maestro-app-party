import type { MonitorState } from "@maestro-mobile/shared";
import type { MonitorReadService, MonitorReadSnapshot } from "./monitor-read-service.js";

export class MonitorQueryService {
  constructor(private readonly monitor: MonitorReadService) {}

  read(): Promise<MonitorReadSnapshot> {
    return this.monitor.read();
  }

  readState(): Promise<MonitorState> {
    return this.monitor.read().then(({ state }) => state);
  }
}

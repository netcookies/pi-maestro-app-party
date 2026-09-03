import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventLog } from "../src/event-log.js";
import type { HostEvent } from "@maestro-mobile/shared";

function makeEvent(overrides: Partial<HostEvent> = {}): HostEvent {
  return { type: "host_status", status: "idle", seq: 0, ...overrides } as HostEvent;
}

describe("EventLog", () => {
  let log: EventLog;

  beforeEach(() => {
    log = new EventLog(100);
  });

  it("starts at seq 1", () => {
    expect(log.nextSequence).toBe(1);
  });

  it("increments seq on each record", () => {
    const e1 = log.record(makeEvent({ type: "host_status", status: "a" }));
    expect(e1.seq).toBe(1);
    const e2 = log.record(makeEvent({ type: "host_status", status: "b" }));
    expect(e2.seq).toBe(2);
  });

  it("eventsSince returns only newer events", () => {
    log.record(makeEvent({ type: "host_status", status: "a" }));
    log.record(makeEvent({ type: "host_status", status: "b" }));
    const after = log.eventsSince(1);
    expect(after).toHaveLength(1);
    expect(after[0].seq).toBe(2);
  });

  it("eventsSince returns empty for latest seq", () => {
    log.record(makeEvent());
    expect(log.eventsSince(2)).toHaveLength(0);
  });

  it("limits max entries", () => {
    const smallLog = new EventLog(3);
    for (let i = 0; i < 5; i++) {
      smallLog.record(makeEvent({ type: "host_status", status: String(i) }));
    }
    expect(smallLog.all.length).toBe(3);
  });
});
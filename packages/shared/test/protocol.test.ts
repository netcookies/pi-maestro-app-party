import { describe, expect, it } from "vitest";
import {
  isHostEvent,
  isClientCommand,
  type HostEvent,
  type ClientCommand,
  type MaestroState,
  type ExtensionUiRequest,
} from "../src/protocol.js";

describe("protocol", () => {
  it("validates HostEvent shape", () => {
    const event: HostEvent = { type: "session_updated", session: {} as never, seq: 1 };
    expect(isHostEvent(event)).toBe(true);
  });

  it("rejects malformed HostEvent", () => {
    expect(isHostEvent({ type: "session_updated" })).toBe(false);
    expect(isHostEvent(null)).toBe(false);
    expect(isHostEvent("string")).toBe(false);
  });

  it("validates ClientCommand shape", () => {
    const cmd: ClientCommand = { type: "prompt", sessionId: "s1", message: "hi" };
    expect(isClientCommand(cmd)).toBe(true);
  });

  it("rejects malformed ClientCommand", () => {
    expect(isClientCommand({})).toBe(false);
    expect(isClientCommand(null)).toBe(false);
  });

  it("supports backward-compatible host session pagination fields", () => {
    const command: ClientCommand = {
      type: "list_host_sessions",
      cwd: "/work/app",
      query: "model",
      limit: 25,
      cursor: "opaque",
      sessionIds: ["live-1"],
      latestForCwds: ["/work/running"],
    };
    expect(isClientCommand(command)).toBe(true);
  });

  it("builds a valid MaestroState with schedules", () => {
    const state: MaestroState = {
      schedules: [
        {
          scheduleId: "sch-1",
          title: "Test schedule",
          state: "active",
          progress: { completed: 1, total: 2 },
          steps: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(state.schedules.length).toBe(1);
    expect(state.schedules[0].state).toBe("active");
  });

  it("serializes ExtensionUiRequest without loss", () => {
    const req: ExtensionUiRequest = {
      id: "req-1",
      sessionId: "s1",
      method: "select",
      title: "Pick an option",
      options: ["A", "B"],
    };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as ExtensionUiRequest;
    expect(parsed).toEqual(req);
  });
});

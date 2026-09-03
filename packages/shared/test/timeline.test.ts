import { describe, expect, it } from "vitest";
import { projectEventToTimeline, createTimelineProjectionState, isUserMessage } from "../src/timeline.js";
import type { HostEvent, TimelineItem } from "../src/protocol.js";

describe("timeline projection", () => {
  it("passes through timeline_item events", () => {
    const state = createTimelineProjectionState();
    const item: TimelineItem = {
      id: "t1",
      kind: "user",
      text: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const event: HostEvent = { type: "timeline_item", sessionId: "s1", item, seq: 1 };
    const items = projectEventToTimeline(state, event);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("t1");
  });

  it("returns empty for non-timeline events", () => {
    const state = createTimelineProjectionState();
    const event: HostEvent = { type: "host_status", status: "idle", seq: 1 };
    expect(projectEventToTimeline(state, event)).toEqual([]);
  });

  it("detects duplicate user messages", () => {
    const items: TimelineItem[] = [
      { id: "1", kind: "user", text: "hello", createdAt: "" },
    ];
    expect(isUserMessage("hello", items)).toBe(false);
    expect(isUserMessage("different", items)).toBe(true);
    expect(isUserMessage("", items)).toBe(false);
  });
});

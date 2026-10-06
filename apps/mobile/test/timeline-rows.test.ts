import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@maestro-mobile/shared";
import { buildTimelineRows } from "../src/timeline-rows.js";

const item = (id: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id, kind: "tool", text: id, createdAt: "2026-01-01T00:00:00.000Z", toolName: "read", status: "completed", ...extra,
});

describe("buildTimelineRows", () => {
  it("omits empty assistant placeholders without hiding errors or image-only messages", () => {
    const rows = buildTimelineRows([
      { id: "empty", kind: "assistant", text: "  ", createdAt: "" },
      { id: "failed", kind: "assistant", text: "", createdAt: "", error: { code: "provider_error", message: "failed", source: "provider" } },
      { id: "image", kind: "assistant", text: "", createdAt: "", images: ["/tmp/image.png"] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.type === "item" ? row.item.id : row.id)).toEqual(["failed", "image"]);
  });
  it("groups consecutive ordinary tools and keeps a stable first-item key", () => {
    const rows = buildTimelineRows([item("a", { toolCallId: "call-a" }), item("b", { toolCallId: "call-b" })]);
    expect(rows).toEqual([{ type: "tool_group", id: "a", items: expect.any(Array), invocationCount: 2, status: "completed" }]);
  });

  it("keeps tool failures in the consecutive group and marks the group failed", () => {
    const rows = buildTimelineRows([item("a"), { id: "assistant", kind: "assistant", text: "done", createdAt: "" }, item("b"), item("c", { isError: true, status: "failed" }), item("d")]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item", "tool_group"]);
    expect(rows[2]).toMatchObject({ type: "tool_group", status: "failed", invocationCount: 3 });
  });

  it("keeps pending Ask and Plan visible as interaction boundaries", () => {
    const rows = buildTimelineRows([item("a"), item("ask", { toolName: "ask-user-question", status: "running", toolCallId: "ask-1" }), item("b"), item("plan", { toolName: "plan", status: "running" }), item("c")]);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toMatchObject({ type: "item", item: { id: "ask" } });
    expect(rows[3]).toMatchObject({ type: "item", item: { id: "plan" } });
  });

  it("marks a live call completed when its correlated result is in the same group", () => {
    const rows = buildTimelineRows([
      item("live-toolcall-c1", { toolCallId: "c1", status: undefined }),
      item("live-tool-c1", { toolCallId: "c1", status: undefined }),
    ]);
    expect(rows[0]).toMatchObject({ type: "tool_group", status: "completed" });
  });

  it("does not mutate source items", () => {
    const source = [item("a", { status: "running", toolCallId: "a" }), item("b", { status: "failed", toolCallId: "b", isError: true })];
    const rows = buildTimelineRows(source);
    expect(rows[0]).toMatchObject({ type: "tool_group", status: "running" });
    expect(source[0]?.status).toBe("running");
  });
});

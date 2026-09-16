import { describe, expect, it } from "vitest";
import type { HostSessionSummary } from "@maestro-mobile/shared";
import {
  beginFilterRequest,
  createFilterState,
  filterSessionSummaries,
  isFilterResponseCurrent,
  isPageResponseCurrent,
  updateFilterState,
} from "../src/filter-state.js";

function session(id: string, visibility: "session_list" | "monitor_tab", title = id): HostSessionSummary {
  return {
    id, cwd: "/project", cwdName: "project", path: `/sessions/${id}.jsonl`, title,
    messageCount: 1, updatedAt: "2026-01-01T00:00:00.000Z",
    presentation: {
      role: visibility === "monitor_tab" ? "monitor" : "session",
      visibility,
      control: { mode: "readonly", canPrompt: false, canSteer: false, canFollowUp: false, canAbort: false, canAnswerAsk: false },
      revision: 1,
    },
  };
}

describe("filter state", () => {
  it("filters only by server presentation visibility and normalized query", () => {
    const sessions = [session("a", "session_list", "Alpha"), session("b", "monitor_tab", "Beta")];
    expect(filterSessionSummaries(sessions, { query: " alp ", visibility: "session_list" }).map((item) => item.id)).toEqual(["a"]);
    expect(filterSessionSummaries(sessions, { visibility: "monitor_tab" }).map((item) => item.id)).toEqual(["b"]);
    expect(filterSessionSummaries([ { ...session("missing", "session_list"), presentation: undefined } ], {}).map((item) => item.id)).toEqual([]);
  });

  it("invalidates first-page responses when the filter changes", () => {
    const initial = createFilterState({ visibility: "session_list" });
    const request = beginFilterRequest(initial);
    const changed = updateFilterState(initial, { query: "new" });
    expect(isFilterResponseCurrent(initial, request)).toBe(true);
    expect(isFilterResponseCurrent(changed, request)).toBe(false);
  });

  it("matches pagination responses to both generation and cursor", () => {
    const state = createFilterState();
    const request = beginFilterRequest(state, "cursor-1");
    expect(isPageResponseCurrent(state, request, "cursor-1")).toBe(true);
    expect(isPageResponseCurrent(state, request, "cursor-2")).toBe(false);
    expect(isPageResponseCurrent(updateFilterState(state, { cwds: ["/other"] }), request, "cursor-1")).toBe(false);
  });

  it("supports project cwd multi-select and normalizes drafts", () => {
    const sessions = [
      session("a", "session_list", "Alpha"),
      { ...session("b", "session_list", "Beta"), cwd: "/other" },
      { ...session("c", "session_list", "Gamma"), cwd: "/third" },
    ];
    expect(filterSessionSummaries(sessions, { cwds: ["/project", "/third"] }).map((s) => s.id)).toEqual(["a", "c"]);
    // 空 cwd 数组语义等同不过滤
    expect(filterSessionSummaries(sessions, { cwds: [] }).length).toBe(3);
    // 空白项剔除后仍可匹配
    expect(filterSessionSummaries(sessions, { cwds: [" /third "] }).map((s) => s.id)).toEqual(["c"]);
    // cwds 变化使在途响应失效（race-safe）
    const st = createFilterState();
    const req = beginFilterRequest(st);
    expect(isFilterResponseCurrent(updateFilterState(st, { cwds: ["/project"] }), req)).toBe(false);
    expect(isFilterResponseCurrent(updateFilterState(st, { cwds: [] }), req)).toBe(false);
  });
});

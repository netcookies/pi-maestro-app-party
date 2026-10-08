import { describe, expect, it } from "vitest";
import { isSessionDetailHydrated } from "../src/session-detail-state.js";

describe("session detail hydration gate", () => {
  it("keeps an exact-target snapshot hydrated while interaction state is transient", () => {
    expect(isSessionDetailHydrated({
      targetKey: "[\"session\",\"desktop\",\"/work\",\"generation\"]",
      targetProjectionReady: true,
      hasTimelineSnapshot: true,
    })).toBe(true);
  });

  it("does not treat an unresolved target or missing snapshot as hydrated", () => {
    expect(isSessionDetailHydrated({ targetProjectionReady: true, hasTimelineSnapshot: true })).toBe(false);
    expect(isSessionDetailHydrated({ targetKey: "target", targetProjectionReady: false, hasTimelineSnapshot: true })).toBe(false);
    expect(isSessionDetailHydrated({ targetKey: "target", targetProjectionReady: true, hasTimelineSnapshot: false })).toBe(false);
  });
});

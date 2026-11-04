import { describe, expect, it } from "vitest";
import { isSessionDetailHydrated, shouldFollowBottomAfterViewportResize } from "../src/session-detail-state.js";

describe("session detail state", () => {
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

  it("keeps the latest messages visible when the viewport shrinks while already at the bottom", () => {
    expect(shouldFollowBottomAfterViewportResize(700, 380, true)).toBe(true);
  });

  it("does not override a user's scroll position or react to initial/growing layouts", () => {
    expect(shouldFollowBottomAfterViewportResize(700, 380, false)).toBe(false);
    expect(shouldFollowBottomAfterViewportResize(0, 380, true)).toBe(false);
    expect(shouldFollowBottomAfterViewportResize(380, 700, true)).toBe(false);
    expect(shouldFollowBottomAfterViewportResize(380, 380, true)).toBe(false);
  });
});

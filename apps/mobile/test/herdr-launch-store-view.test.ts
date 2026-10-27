import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

vi.mock("expo-notifications", () => ({
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(async () => ({ granted: false })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: false })),
  scheduleNotificationAsync: vi.fn(async () => "test-notification"),
}));

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 1, Medium: 2, Heavy: 3 },
  NotificationFeedbackType: { Success: 1, Warning: 2, Error: 3 },
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: "ios" },
  NativeModules: {},
}));

import { herdrCloseOutcome, isHerdrLaunchedSpace } from "../src/store";

describe("herdr close outcome classification", () => {
  it("reads the business outcome from the command result payload", () => {
    expect(herdrCloseOutcome({ ok: true, status: "observed", result: { status: "closed" } })).toBe("closed");
    expect(herdrCloseOutcome({ ok: true, status: "observed", result: { status: "close_timeout" } })).toBe("close_timeout");
    expect(herdrCloseOutcome({ ok: true, status: "observed", result: { status: "herdr_session_busy" } })).toBe("herdr_session_busy");
    expect(herdrCloseOutcome({ ok: true, status: "observed", result: { status: "herdr_session_not_owned" } })).toBe("herdr_session_not_owned");
  });

  it("classifies a missing or malformed payload as unknown instead of assuming closed", () => {
    expect(herdrCloseOutcome(undefined)).toBe("unknown");
    expect(herdrCloseOutcome({ ok: false, status: "failed" })).toBe("unknown");
    expect(herdrCloseOutcome({ result: { status: "something_else" } })).toBe("unknown");
    expect(herdrCloseOutcome({ result: null })).toBe("unknown");
  });
});

describe("herdr launched space detection", () => {
  const settings = {
    settings: { runtime: "auto", resumeHistory: true, autoCleanupSpace: true },
    favorites: [],
    launchedSpaces: [{ paneId: "w9:p1", cwd: "/work/app", launchedAt: "2026-01-01T00:00:00.000Z" }],
  };

  it("recognizes a registered pane", () => {
    expect(isHerdrLaunchedSpace(settings, "s1")).toBe(true);
    expect(isHerdrLaunchedSpace(settings, "s1", "e1")).toBe(true);
  });

  it("does not claim ownership without a non-empty pane list", () => {
    expect(isHerdrLaunchedSpace({ ...settings, launchedSpaces: [] }, "s1")).toBe(false);
    expect(isHerdrLaunchedSpace({ settings, favorites: [] }, "s1")).toBe(false);
    expect(isHerdrLaunchedSpace(undefined, "s1")).toBe(false);
  });

  it("rejects malformed entries", () => {
    expect(isHerdrLaunchedSpace({ launchedSpaces: [{ cwd: "/work" }] }, "s1")).toBe(false);
    expect(isHerdrLaunchedSpace({ launchedSpaces: "nope" }, "s1")).toBe(false);
  });
});

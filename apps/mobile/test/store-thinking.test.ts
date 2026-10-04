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

import { normalizeThinkingResult } from "../src/store";

describe("thinking command result normalization", () => {
  it("treats an acknowledged command with no result payload as success", () => {
    expect(normalizeThinkingResult(null)).toEqual({ ok: true });
    expect(normalizeThinkingResult(undefined)).toEqual({ ok: true });
  });

  it("preserves an explicit rejected result for the local error channel", () => {
    expect(normalizeThinkingResult({ ok: false, error: "unsupported" })).toEqual({ ok: false, error: "unsupported" });
  });
});

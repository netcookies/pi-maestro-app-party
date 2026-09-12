import { describe, expect, it, vi } from "vitest";
import {
  hapticImpactLight,
  hapticImpactMedium,
  hapticSelection,
  hapticNotificationSuccess,
  hapticNotificationWarning,
} from "../src/utils/haptics";

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  selectionAsync: vi.fn().mockResolvedValue(undefined),
  notificationAsync: vi.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

describe("Haptics Engine", () => {
  it("invokes haptic methods safely without throwing", async () => {
    await expect(hapticImpactLight()).resolves.toBeUndefined();
    await expect(hapticImpactMedium()).resolves.toBeUndefined();
    await expect(hapticSelection()).resolves.toBeUndefined();
    await expect(hapticNotificationSuccess()).resolves.toBeUndefined();
    await expect(hapticNotificationWarning()).resolves.toBeUndefined();
  });
});

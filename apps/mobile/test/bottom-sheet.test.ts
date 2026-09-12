import { describe, expect, it, vi } from "vitest";

// Mock react-native
vi.mock("react-native", () => ({
  Animated: {
    Value: class {
      val: number;
      constructor(v: number) { this.val = v; }
      setValue(v: number) { this.val = v; }
      interpolate() { return this; }
    },
    timing: () => ({ start: (cb?: () => void) => cb?.() }),
    spring: () => ({ start: (cb?: () => void) => cb?.() }),
    parallel: (arr: any[]) => ({ start: (cb?: () => void) => cb?.() }),
  },
  PanResponder: {
    create: (config: any) => config,
  },
  Pressable: "Pressable",
  StyleSheet: {
    create: (styles: any) => styles,
    absoluteFillObject: {},
    absoluteFill: {},
  },
  View: "View",
  Dimensions: {
    get: () => ({ width: 390, height: 844 }),
  },
}));

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

import { shouldDismissSheet, SpringBottomSheet } from "../src/components/SpringBottomSheet";

describe("SpringBottomSheet", () => {
  it("determines dismiss based on distance and velocity", () => {
    // 距离未超，速度未超 -> 不关闭
    expect(shouldDismissSheet(50, 0.2)).toBe(false);

    // 距离超过 80 -> 关闭
    expect(shouldDismissSheet(85, 0.1)).toBe(true);

    // 距离小但向下一甩速度 > 0.8 -> 关闭
    expect(shouldDismissSheet(30, 0.9)).toBe(true);

    // 反向拖拽 (向上) -> 不关闭
    expect(shouldDismissSheet(-20, -0.5)).toBe(false);
  });

  it("exports SpringBottomSheet React component", () => {
    expect(typeof SpringBottomSheet).toBe("function");
  });
});

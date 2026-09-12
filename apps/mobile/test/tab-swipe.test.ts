import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Dimensions: {
    get: () => ({ width: 390, height: 844 }),
  },
  PanResponder: {
    create: (cfg: any) => cfg,
  },
  Animated: {
    Value: class {
      value: number;
      constructor(v: number) { this.value = v; }
      setValue(v: number) { this.value = v; }
      interpolate() { return this; }
    },
    spring: () => ({ start: (cb?: any) => cb && cb() }),
    timing: () => ({ start: (cb?: any) => cb && cb() }),
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../src/utils/haptics", () => ({
  hapticImpactLight: vi.fn(),
}));

import { shouldTriggerTabSwipe } from "../src/hooks/useTabSwipe";

describe("shouldTriggerTabSwipe", () => {
  it("detects swipe to left (next tab)", () => {
    // dx: -80, dy: 10 -> 水平向左滑动足够长
    expect(shouldTriggerTabSwipe(-80, 10, -0.2)).toBe("right");
  });

  it("detects swipe to right (previous tab)", () => {
    // dx: 80, dy: 10 -> 水平向右滑动足够长
    expect(shouldTriggerTabSwipe(80, 10, 0.2)).toBe("left");
  });

  it("ignores vertical scrolling gestures", () => {
    // 上下滚动列表：dy 远大于 dx
    expect(shouldTriggerTabSwipe(10, 100, 0)).toBe(null);
    expect(shouldTriggerTabSwipe(-15, 80, 0)).toBe(null);
  });

  it("ignores tiny accidental touch offsets", () => {
    expect(shouldTriggerTabSwipe(20, 5, 0.1)).toBe(null);
    expect(shouldTriggerTabSwipe(-25, 5, -0.1)).toBe(null);
  });
});

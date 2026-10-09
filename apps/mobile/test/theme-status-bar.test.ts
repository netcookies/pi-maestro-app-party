import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ useColorScheme: () => "light" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

import { THEMES } from "../src/theme";

describe("theme status bar contrast", () => {
  it.each([
    ["miuix-light", "dark"],
    ["notion", "dark"],
    ["miuix-dark", "light"],
    ["dark", "light"],
    ["ocean", "light"],
    ["zen", "light"],
  ])("uses %s with %s system icons", (name, style) => {
    expect(THEMES[name].statusBarStyle).toBe(style);
  });

  it.each(Object.entries(THEMES))("keeps %s status icons readable over the header", (_name, theme) => {
    const channels = theme.headerBg.slice(1).match(/.{2}/g)!.map((hex) => {
      const value = parseInt(hex, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    const contrast = theme.statusBarStyle === "dark" ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });
});

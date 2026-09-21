import { describe, expect, it } from "vitest";
import {
  isCompatibleReleaseVersion,
  isReleaseVersion,
  parseRolloutMode,
  MOBILE_RELEASE_VERSION,
} from "../src/release.js";

describe("release contract", () => {
  it("accepts only semver release versions and couples the current release", () => {
    expect(isReleaseVersion(MOBILE_RELEASE_VERSION)).toBe(true);
    expect(isReleaseVersion("0.4")).toBe(false);
    // 用当前常量表达「自身被接受 / 其他被拒」，避免硬编码版本在发版后变成真版本。
    expect(isCompatibleReleaseVersion(MOBILE_RELEASE_VERSION)).toBe(true);
    expect(isCompatibleReleaseVersion(MOBILE_RELEASE_VERSION === "0.0.1" ? "0.0.2" : "0.0.1")).toBe(false);
    expect(isCompatibleReleaseVersion("test")).toBe(false);
  });

  it("uses enabled as the safe default and rejects unknown rollout values", () => {
    expect(parseRolloutMode(undefined)).toBe("enabled");
    expect(parseRolloutMode("disabled")).toBe("disabled");
    expect(parseRolloutMode("shadow")).toBe("shadow");
    expect(parseRolloutMode("unexpected")).toBe("enabled");
    expect(parseRolloutMode("unexpected", "disabled")).toBe("disabled");
  });
});

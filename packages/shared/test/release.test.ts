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
    expect(isCompatibleReleaseVersion("0.4.0")).toBe(true);
    expect(isCompatibleReleaseVersion("0.5.0")).toBe(false);
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

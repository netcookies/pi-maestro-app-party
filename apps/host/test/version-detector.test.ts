import { describe, expect, it, beforeEach, vi } from "vitest";
import { VersionDetector } from "../src/version-detector.js";

describe("VersionDetector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caches detection result (detect called once for repeated calls)", async () => {
    const detector = new VersionDetector();
    const spy = vi.spyOn(detector as unknown as { detectOnce: () => Promise<Record<string, string>> }, "detectOnce")
      .mockResolvedValue({ piVersion: "0.85.1", flowVersion: "0.27.1", maestroCliVersion: "0.5.85" });

    const first = await detector.detect();
    const second = await detector.detect();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("omits absent fields rather than returning undefined values", async () => {
    const detector = new VersionDetector();
    vi.spyOn(detector as unknown as { detectOnce: () => Promise<Record<string, string>> }, "detectOnce")
      .mockResolvedValue({ piVersion: "0.85.1" });

    const v = await detector.detect();
    expect(v).toEqual({ piVersion: "0.85.1" });
    expect("flowVersion" in v).toBe(false);
  });

  it("reset clears cache so detect runs again", async () => {
    const detector = new VersionDetector();
    const spy = vi.spyOn(detector as unknown as { detectOnce: () => Promise<Record<string, string>> }, "detectOnce")
      .mockResolvedValue({ piVersion: "x" });

    await detector.detect();
    detector.reset();
    await detector.detect();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from "vitest";
import { collectImagePaths } from "../src/tool-images";

describe("collectImagePaths", () => {
  it("collects paths from explicit images array", () => {
    const item = { text: "result", images: ["/tmp/explicit-1.png", "/tmp/explicit-2.jpg"] };
    expect(collectImagePaths(item)).toEqual([
      "/tmp/explicit-1.png",
      "/tmp/explicit-2.jpg",
    ]);
  });

  it("extracts paths from tool result text when images is undefined", () => {
    const item = {
      text: "Wrote screenshot to: /tmp/screenshot-2026-11-02.png\nSaved at 1200x800",
    };
    expect(collectImagePaths(item)).toEqual([
      "/tmp/screenshot-2026-11-02.png",
    ]);
  });

  it("merges and deduplicates explicit images and text image paths preserving order", () => {
    const item = {
      text: "also refer to /tmp/screenshot-2.png and /tmp/screenshot-1.png",
      images: ["/tmp/screenshot-1.png"],
    };
    expect(collectImagePaths(item)).toEqual([
      "/tmp/screenshot-1.png",
      "/tmp/screenshot-2.png",
    ]);
  });

  it("handles empty or non-image text without crashing", () => {
    expect(collectImagePaths({ text: "command executed successfully with code 0" })).toEqual([]);
    expect(collectImagePaths({ text: "" })).toEqual([]);
  });
});

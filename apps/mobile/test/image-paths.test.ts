import { describe, expect, it } from "vitest";
import { extractImagePaths, isImagePath, splitImageSegments } from "../src/image-paths.js";

describe("extractImagePaths", () => {
  it("extracts plain absolute png path", () => {
    const text = "图片已保存到 /tmp/pi-clipboard-abc.png";
    expect(extractImagePaths(text)).toEqual(["/tmp/pi-clipboard-abc.png"]);
  });

  it("extracts path with hyphens and uuid", () => {
    const text = "screenshot: /tmp/pi-clipboard-80e03610-156f-4b44-bee9-bf22e4d2986f.png";
    expect(extractImagePaths(text)).toEqual([
      "/tmp/pi-clipboard-80e03610-156f-4b44-bee9-bf22e4d2986f.png",
    ]);
  });

  it("extracts jpg/webp and deep paths", () => {
    const text = "见 /Users/me/projects/app/screenshot.jpg 和 /var/data/x.webp";
    expect(extractImagePaths(text)).toEqual([
      "/Users/me/projects/app/screenshot.jpg",
      "/var/data/x.webp",
    ]);
  });

  it("deduplicates repeated paths", () => {
    const text = "路径：/tmp/a.png （再次提到 /tmp/a.png）";
    expect(extractImagePaths(text)).toEqual(["/tmp/a.png"]);
  });

  it("ignores non-absolute or non-image paths", () => {
    expect(extractImagePaths("relative.png 和 /tmp/readme.md")).toEqual([]);
    expect(extractImagePaths("no image here")).toEqual([]);
  });

  it("extracts file:// URIs", () => {
    const text = "✓ resource file:///tmp/pi-clipboard-4cc668d5-bf2b-42dd-a95a-bf7d41ff5336.png · Unsupported scheme";
    expect(extractImagePaths(text)).toEqual([
      "/tmp/pi-clipboard-4cc668d5-bf2b-42dd-a95a-bf7d41ff5336.png",
    ]);
  });

  it("keeps both file:// and bare paths deduped", () => {
    const text = "file:///tmp/a.png 同 /tmp/a.png";
    expect(extractImagePaths(text)).toEqual(["/tmp/a.png"]);
  });

  it("extracts Windows drive paths with backslashes", () => {
    const text = "截图已保存到 C:\\Users\\me\\Pictures\\shot.png";
    expect(extractImagePaths(text)).toEqual(["C:\\Users\\me\\Pictures\\shot.png"]);
  });

  it("extracts Windows drive paths with forward slashes", () => {
    const text = "saved to C:/Users/me/Pictures/shot.png ok";
    expect(extractImagePaths(text)).toEqual(["C:/Users/me/Pictures/shot.png"]);
  });

  it("extracts Windows file:///C:/ URI and strips leading slash", () => {
    const text = "✓ resource file:///C:/Users/me/Pictures/shot.png";
    expect(extractImagePaths(text)).toEqual(["C:/Users/me/Pictures/shot.png"]);
  });

  it("does not treat relative windows-ish text as path", () => {
    expect(extractImagePaths("see docs D: and notes")).toEqual([]);
  });
});

describe("isImagePath", () => {
  it("accepts absolute image paths", () => {
    expect(isImagePath("/tmp/a.png")).toBe(true);
    expect(isImagePath("/Users/x/y/photo.jpeg")).toBe(true);
  });
  it("accepts Windows drive image paths", () => {
    expect(isImagePath("C:\\Users\\me\\shot.png")).toBe(true);
    expect(isImagePath("C:/Users/me/shot.png")).toBe(true);
    expect(isImagePath("C:/Users/me/shot.txt")).toBe(false);
    expect(isImagePath("C:/Users/me")).toBe(false);
  });
  it("rejects others", () => {
    expect(isImagePath("a.png")).toBe(false);
    expect(isImagePath("/tmp/a.txt")).toBe(false);
    expect(isImagePath("/tmp/a")).toBe(false);
  });
});

describe("splitImageSegments", () => {
  it("splits text around image paths", () => {
    const segs = splitImageSegments("看这里 /tmp/a.png 的内容");
    expect(segs).toEqual([
      { type: "text", text: "看这里" },
      { type: "image", path: "/tmp/a.png" },
      { type: "text", text: "的内容" },
    ]);
  });

  it("returns single text segment when no image", () => {
    const segs = splitImageSegments("没有图片");
    expect(segs).toEqual([{ type: "text", text: "没有图片" }]);
  });

  it("handles multiple images", () => {
    const segs = splitImageSegments("/tmp/a.png 和 /tmp/b.jpg");
    expect(segs.filter((s) => s.type === "image")).toHaveLength(2);
  });

  it("trims line noise around paths", () => {
    const segs = splitImageSegments("> /tmp/a.png\n继续");
    expect(segs).toEqual([
      { type: "text", text: "" },
      { type: "image", path: "/tmp/a.png" },
      { type: "text", text: "继续" },
    ]);
  });
});
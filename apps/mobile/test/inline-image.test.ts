import { describe, expect, it } from "vitest";
import { imageUrlFor } from "../src/image-url";

describe("imageUrlFor", () => {
  it("converts ws:// host to http:// image URL", () => {
    expect(imageUrlFor("ws://127.0.0.1:4739/ws", "/tmp/a.png")).toBe(
      "http://127.0.0.1:4739/api/file?path=%2Ftmp%2Fa.png",
    );
  });

  it("works with wss:// (secure) hosts", () => {
    const url = imageUrlFor("wss://example.com:4739/ws", "/Users/x/y.png");
    expect(url.startsWith("https://example.com:4739/api/file?path=")).toBe(true);
    expect(url).toContain(encodeURIComponent("/Users/x/y.png"));
  });

  it("keeps http:// hosts as-is", () => {
    expect(imageUrlFor("http://10.0.0.2:4739/ws", "/tmp/b.jpg")).toBe(
      "http://10.0.0.2:4739/api/file?path=%2Ftmp%2Fb.jpg",
    );
  });

  it("returns empty for missing inputs", () => {
    expect(imageUrlFor("", "/tmp/a.png")).toBe("");
    expect(imageUrlFor("ws://x/ws", "")).toBe("");
  });

  it("URL-encodes spaces and special chars in path", () => {
    const url = imageUrlFor("ws://127.0.0.1:4739/ws", "/tmp/my photo.png");
    expect(url).toContain("my%20photo.png");
  });
});
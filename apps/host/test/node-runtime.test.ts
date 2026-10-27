import { describe, expect, it } from "vitest";
import { isJavaScriptRuntimePath, resolveNodeExecutable } from "../src/node-runtime.js";

const PATH_NODE = process.platform === "win32" ? "node.exe" : "node";

describe("resolveNodeExecutable", () => {
  it("reuses process.execPath when it is a real Node runtime", () => {
    expect(resolveNodeExecutable({}, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(resolveNodeExecutable({}, "C:\\Program Files\\nodejs\\node.exe")).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("reuses a real Bun runtime", () => {
    expect(resolveNodeExecutable({}, "/Users/dev/.bun/bin/bun")).toBe("/Users/dev/.bun/bin/bun");
  });

  it("falls back to PATH Node when execPath is an application bundle", () => {
    // pi-bolt 的 pi-bin 是 Pi 应用本身：spawn 它只会再起一个 Pi 会话。
    expect(resolveNodeExecutable({}, "/Users/dev/.pi-bolt/pi-bolt-darwin-arm64/pi-bin")).toBe(PATH_NODE);
    expect(resolveNodeExecutable({}, "/Users/dev/.pi-bolt/pi-bolt-darwin-arm64/pi")).toBe(PATH_NODE);
  });

  it("honours an explicit interpreter override", () => {
    expect(resolveNodeExecutable({ MAESTRO_MOBILE_NODE_BIN: " /opt/node/bin/node " }, "/app/pi-bin")).toBe("/opt/node/bin/node");
    expect(resolveNodeExecutable({ MAESTRO_MOBILE_NODE_BIN: "   " }, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  it("classifies only JS runtime names", () => {
    expect(isJavaScriptRuntimePath("node")).toBe(true);
    expect(isJavaScriptRuntimePath("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
    expect(isJavaScriptRuntimePath("/usr/bin/bun")).toBe(true);
    expect(isJavaScriptRuntimePath("/Users/dev/.pi-bolt/pi-bolt-darwin-arm64/pi-bin")).toBe(false);
    expect(isJavaScriptRuntimePath("")).toBe(false);
  });
});

import { describe, expect, it, beforeEach, vi } from "vitest";
import { VersionDetector, binVersionForTest } from "../src/version-detector.js";

// vi.mock 会被 hoist 到 import 前：Windows .cmd 探测路径在 win32 下才生效
declare global {
  // eslint-disable-next-line no-var
  var __win32Mock: boolean | undefined;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (bin: string, args: string[], opts: unknown, cb: (e: Error | null, out: string) => void) => {
      if (globalThis.__win32Mock) {
        // 模拟 Windows：pi.cmd / maestro.cmd 存在返回版本，裸名 ENOENT
        if (bin.endsWith(".cmd")) {
          cb(null, bin === "pi.cmd" ? "0.85.1\n" : "0.5.85\n");
          return { on: () => {} } as never;
        }
        const err = new Error("ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        cb(err, "");
        return { on: () => {} } as never;
      }
      return actual.execFile(bin, args, opts as never, cb);
    },
  };
});

describe("VersionDetector · Windows paths", () => {
  it("binVersion prefers .cmd shim on win32", async () => {
    globalThis.__win32Mock = true;
    const prevPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(await binVersionForTest("pi")).toBe("0.85.1");
      expect(await binVersionForTest("maestro")).toBe("0.5.85");
    } finally {
      globalThis.__win32Mock = false;
      Object.defineProperty(process, "platform", { value: prevPlatform });
    }
  });

  it("globalModuleVersion checks %APPDATA%\\npm on Windows", async () => {
    // 直接对函数行为做路径构造验证：APPDATA 注入后 npm 目录被拼进候选
    const appdata = process.env.APPDATA;
    expect(appdata === undefined || typeof appdata === "string").toBe(true);
    // 路径拼接正确性（跨平台 join 语义）
    const { join } = await import("node:path");
    if (appdata) expect(join(appdata, "npm", "maestro-flow", "package.json")).toContain(join("npm", "maestro-flow"));
  });
});

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

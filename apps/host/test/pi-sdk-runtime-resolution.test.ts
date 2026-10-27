import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { loadPiSdk, findManagedPiSdkPackageDir } from "../src/pi/pi-sdk-runtime.js";

/** 造一个最小可解析的 Pi 包目录（fakeEntry 省略时只有 manifest、没有可用入口） */
async function fakePiPackage(fakeEntry?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sdk-"));
  const exportsField = fakeEntry ? { ".": { import: `./${fakeEntry}` } } : undefined;
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0", exports: exportsField }),
  );
  if (fakeEntry) {
    await writeFile(
      join(dir, fakeEntry),
      "export const SessionManager = { list: async (cwd) => [{ id: \"injected\", cwd }] };\n",
    );
  }
  return dir;
}

const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalPiPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = originalPiPackageDir;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("loadPiSdk", () => {
  it("优先使用宿主注入的 PI_PACKAGE_DIR", async () => {
    process.env.PI_PACKAGE_DIR = await fakePiPackage("index.js");

    const { SessionManager } = await loadPiSdk();

    await expect(SessionManager.list("/work/project")).resolves.toEqual([
      { id: "injected", cwd: "/work/project" },
    ]);
  });

  it("managed Pi installation 按 current-version 定位可导入 SDK", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-"));
    const packageDir = join(
      agentDir,
      "install",
      "releases",
      "1.4.0",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(agentDir, "install", "current-version"), "1.4.0\n");
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } }),
    );
    await mkdir(join(packageDir, "dist"));
    await writeFile(join(packageDir, "dist", "index.js"), "export const SessionManager = {};\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await expect(findManagedPiSdkPackageDir()).resolves.toBe(packageDir);
  });

  it("忽略不安全或不合法的 managed current-version", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-"));
    await mkdir(join(agentDir, "install"), { recursive: true });
    await writeFile(join(agentDir, "install", "current-version"), "../outside\n");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await expect(findManagedPiSdkPackageDir()).resolves.toBeUndefined();
  });

  it("注入目录没有可用入口时回落到常规解析", async () => {
    process.env.PI_PACKAGE_DIR = await fakePiPackage();

    const { SessionManager } = await loadPiSdk();

    expect(typeof SessionManager.list).toBe("function");
  });

  it("注入宿主目录与常规解析得到同一份 runtime（不产生第二份副本）", async () => {
    const resolvedNormally = await import("@earendil-works/pi-coding-agent");

    process.env.PI_PACKAGE_DIR = getPackageDir();
    const injected = await loadPiSdk();

    expect(injected.SessionManager).toBe(resolvedNormally.SessionManager);
  });
});

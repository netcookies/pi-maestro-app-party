import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrAdapter, HERDR_LAUNCH_NONCE_ENV, type HerdrAdapterOptions } from "../src/herdr-adapter.js";

const status = JSON.stringify({ status: "running", running: true, version: "0.9.5", protocol: 22, compatible: true, capabilities: ["pane.split", "pane.run"] });
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cwd(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "herdr-adapter-"));
  dirs.push(path);
  return path;
}

function adapter(run: NonNullable<HerdrAdapterOptions["run"]>, env: NodeJS.ProcessEnv = { HERDR_BIN_PATH: "/usr/bin/env" }): HerdrAdapter {
  return new HerdrAdapter({ env, run, randomNonce: () => "a".repeat(32) });
}

describe("HerdrAdapter", () => {
  it("classifies installed, running, compatible Herdr through the status API", async () => {
    const run = vi.fn(async () => status);
    const value = adapter(run);
    await expect(value.probe()).resolves.toMatchObject({ status: "available", version: "0.9.5", protocol: 22 });
    expect(run).toHaveBeenCalledWith("/usr/bin/env", ["status", "server", "--json"], expect.objectContaining({ timeout: 1500 }));
  });

  it("distinguishes missing, stopped, and incompatible servers", async () => {
    await expect(new HerdrAdapter({ env: { PATH: "" } }).probe()).resolves.toMatchObject({ status: "not_installed" });
    await expect(adapter(async () => JSON.stringify({ status: "not_running", running: false })).probe()).resolves.toMatchObject({ status: "not_running" });
    await expect(adapter(async () => JSON.stringify({ status: "running", running: true, version: "0.9.4", protocol: 22, compatible: true })).probe()).resolves.toMatchObject({ status: "incompatible" });
    await expect(adapter(async () => "not json").probe()).resolves.toMatchObject({ status: "degraded" });
  });

  it("creates an independent Herdr workspace with nonce env and starts Pi as argv", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args, options) => {
      calls.push({ args, env: options.env });
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } });
      return "{}";
    };
    const workingDirectory = await cwd();
    const result = await adapter(run).launchPiPane({ requestId: "request-1", cwd: workingDirectory, label: "Mobile Pi" });
    expect(result).toEqual({ paneId: "w1:p1", launchNonce: "a".repeat(32) });
    expect(calls[1]?.args).toEqual(["workspace", "create", "--cwd", await realpath(workingDirectory), "--env", `${HERDR_LAUNCH_NONCE_ENV}=${"a".repeat(32)}`, "--no-focus", "--label", "Mobile Pi"]);
    expect(calls[2]?.args).toEqual(["pane", "run", "w1:p1", "pi"]);
  });

  it("fails closed on invalid cwd, absent Herdr, and malformed pane creation output", async () => {
    await expect(adapter(async () => status).launchPiPane({ requestId: "r", cwd: "relative" })).rejects.toMatchObject({ stage: "validate_cwd" });
    await expect(adapter(async () => status, { PATH: "" }).launchPiPane({ requestId: "r", cwd: await cwd() })).rejects.toMatchObject({ code: "herdr_not_installed" });
    const malformed = adapter(async (_binary, args) => args[0] === "status" ? status : "{}", { HERDR_BIN_PATH: "/usr/bin/env" });
    await expect(malformed.launchPiPane({ requestId: "r", cwd: await cwd() })).rejects.toMatchObject({ code: "herdr_operation_failed", stage: "create_pane" });
  });

  it("does not pass request-controlled shell content to Herdr", async () => {
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" } } });
      return "{}";
    };
    await expect(adapter(run).launchPiPane({ requestId: "r", cwd: await cwd(), label: "x; rm -rf /" })).rejects.toMatchObject({ stage: "validate_request" });
  });

  it("accepts the mm: label prefix after the label validator allows colon", async () => {
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" }, workspace: { workspace_id: "w1" } } });
      return "{}";
    };
    const workingDirectory = await cwd();
    await expect(adapter(run).launchPiPane({ requestId: "r", cwd: workingDirectory, label: "mm:app" })).resolves.toMatchObject({ paneId: "w:p1", workspaceId: "w1" });
  });

  it("selects the pi-bolt runtime when requested and falls back to pi otherwise", async () => {
    const calls: string[][] = [];
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" } } });
      return "{}";
    };
    const workingDirectory = await cwd();
    await adapter(run).launchPiPane({ requestId: "r", cwd: workingDirectory, runtime: "pi-bolt" });
    await adapter(run).launchPiPane({ requestId: "r2", cwd: workingDirectory });
    const runCalls = calls.filter((args) => args[0] === "pane");
    expect(runCalls[0]).toEqual(["pane", "run", "w:p1", "pi-bolt"]);
    expect(runCalls[1]).toEqual(["pane", "run", "w:p1", "pi"]);
  });

  it("appends --session with a realpath-verified session file instead of --resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-session-"));
    dirs.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, "{}\n", "utf8");
    const calls: string[][] = [];
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" } } });
      return "{}";
    };
    const workingDirectory = await cwd();
    await adapter(run).launchPiPane({ requestId: "r", cwd: workingDirectory, resumeSessionRef: sessionFile });
    const runCall = calls.find((args) => args[0] === "pane");
    expect(runCall?.[2]).toBe("w:p1");
    expect(runCall?.[3]).toBe("pi");
    expect(runCall?.[4]).toBe("--session");
    expect(runCall?.[5]).toBe(await realpath(sessionFile));
    expect(runCall).not.toContain("--resume");
  });

  it("rejects a resume session ref that escapes or does not exist", async () => {
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => (args[0] === "status" ? status : "{}");
    const workingDirectory = await cwd();
    await expect(adapter(run).launchPiPane({ requestId: "r", cwd: workingDirectory, resumeSessionRef: "/work/../etc/passwd" })).rejects.toMatchObject({ stage: "validate_request" });
    await expect(adapter(run).launchPiPane({ requestId: "r2", cwd: workingDirectory, resumeSessionRef: "/definitely/missing/session.jsonl" })).rejects.toMatchObject({ stage: "validate_request" });
  });

  it("probes pi and pi-bolt executability through PATH overrides", async () => {
    const run: NonNullable<HerdrAdapterOptions["run"]> = async () => status;
    await expect(adapter(run, { PATH: "", HERDR_PI_BIN: "/bin/sh", HERDR_PI_BOLT_BIN: "/bin/sh" }).probeRuntimes()).resolves.toEqual({ pi: true, piBolt: true });
    await expect(adapter(run, { PATH: "", HERDR_PI_BIN: "/bin/sh", HERDR_PI_BOLT_BIN: "/definitely/missing/pi-bolt" }).probeRuntimes()).resolves.toEqual({ pi: true, piBolt: false });
  });

  it("sends ctrl+d to a pane and closes a workspace as argv", async () => {
    const calls: string[][] = [];
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [
        { pane_id: "w1:p1", workspace_id: "w1", agent: "pi", agent_status: "idle" },
        { pane_id: "w2:p1", workspace_id: "w2", agent_status: "unknown" },
      ] } });
      return "{}";
    };
    const value = adapter(run);
    await value.sendCtrlD("w1:p1");
    await value.closeWorkspace("w1");
    expect(calls.at(-2)).toEqual(["pane", "send-keys", "w1:p1", "ctrl+d"]);
    expect(calls.at(-1)).toEqual(["workspace", "close", "w1"]);
    const panes = await value.listPanes();
    expect(panes).toEqual([
      { paneId: "w1:p1", workspaceId: "w1", agent: "pi", agentStatus: "idle" },
      { paneId: "w2:p1", workspaceId: "w2", agentStatus: "unknown" },
    ]);
    // Pi 退出后 shell pane 仍在，但没有存活 agent
    expect(HerdrAdapter.hasLiveAgent(panes[0]!)).toBe(true);
    expect(HerdrAdapter.hasLiveAgent(panes[1]!)).toBe(false);
    await expect(value.sendCtrlD("bad;id")).rejects.toMatchObject({ stage: "validate_request" });
  });
});

describe("HerdrAdapter runtime command resolution", () => {
  it("launches the absolute override path when HERDR_PI_BOLT_BIN points outside PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-override-"));
    dirs.push(dir);
    const fakeBolt = join(dir, "custom-pi-bolt");
    await writeFile(fakeBolt, "#!/bin/sh\n", "utf8");
    const calls: string[][] = [];
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" }, workspace: { workspace_id: "w1" } } });
      return "{}";
    };
    const value = new HerdrAdapter({ env: { HERDR_BIN_PATH: "/usr/bin/env", HERDR_PI_BOLT_BIN: fakeBolt }, run, randomNonce: () => "a".repeat(32) });
    const workingDirectory = await cwd();
    // 探测与启动必须一致：探测报告 piBolt 可用，启动就必须执行同一个路径
    await expect(value.probeRuntimes()).resolves.toMatchObject({ piBolt: true });
    await value.launchPiPane({ requestId: "r", cwd: workingDirectory, runtime: "pi-bolt" });
    expect(calls.find((args) => args[0] === "pane")).toEqual(["pane", "run", "w:p1", fakeBolt]);
  });

  it("falls back to the bare command name when no override is configured", async () => {
    const calls: string[][] = [];
    const run: NonNullable<HerdrAdapterOptions["run"]> = async (_binary, args) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" } } });
      return "{}";
    };
    const value = adapter(run);
    await value.launchPiPane({ requestId: "r", cwd: await cwd(), runtime: "pi-bolt" });
    expect(calls.find((args) => args[0] === "pane")).toEqual(["pane", "run", "w:p1", "pi-bolt"]);
  });
});

describe("HerdrAdapter runtime probe/launch consistency", () => {
  function stubRun(calls: string[][]) {
    return (async (_binary: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return status;
      if (args[0] === "workspace") return JSON.stringify({ result: { root_pane: { pane_id: "w:p1" }, workspace: { workspace_id: "w1" } } });
      return "{}";
    }) as NonNullable<HerdrAdapterOptions["run"]>;
  }

  it("keeps probeRuntimes and the launched command consistent for every override state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-consistency-"));
    dirs.push(dir);
    const goodBolt = join(dir, "good-pi-bolt");
    await writeFile(goodBolt, "#!/bin/sh\n", "utf8");
    const brokenBolt = join(dir, "missing-pi-bolt");

    // 1) override 可用：probe 为 true，启动执行该绝对路径
    const callsA: string[][] = [];
    const a = new HerdrAdapter({ env: { HERDR_BIN_PATH: "/usr/bin/env", HERDR_PI_BOLT_BIN: goodBolt }, run: stubRun(callsA), randomNonce: () => "a".repeat(32) });
    expect((await a.probeRuntimes()).piBolt).toBe(true);
    await a.launchPiPane({ requestId: "r", cwd: await cwd(), runtime: "pi-bolt" });
    expect(callsA.find((args) => args[0] === "pane")?.[3]).toBe(goodBolt);

    // 2) override 未配置：probe 依赖 PATH，启动执行裸命令名
    const callsB: string[][] = [];
    const b = adapter(stubRun(callsB));
    await b.launchPiPane({ requestId: "r", cwd: await cwd(), runtime: "pi-bolt" });
    expect(callsB.find((args) => args[0] === "pane")?.[3]).toBe("pi-bolt");

    // 3) override 损坏：probeRuntimes 判为不可用（PATH 为空时），显式选择回退裸命令名
    const callsC: string[][] = [];
    const c = new HerdrAdapter({ env: { PATH: "", HERDR_BIN_PATH: "/usr/bin/env", HERDR_PI_BOLT_BIN: brokenBolt }, run: stubRun(callsC), randomNonce: () => "a".repeat(32) });
    expect((await c.probeRuntimes()).piBolt).toBe(false);
    await c.launchPiPane({ requestId: "r", cwd: await cwd(), runtime: "pi-bolt" });
    expect(callsC.find((args) => args[0] === "pane")?.[3]).toBe("pi-bolt");
  });

  it("applies HERDR_PI_BIN override for the pi runtime too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-pi-override-"));
    dirs.push(dir);
    const customPi = join(dir, "custom-pi");
    await writeFile(customPi, "#!/bin/sh\n", "utf8");
    const calls: string[][] = [];
    const value = new HerdrAdapter({ env: { HERDR_BIN_PATH: "/usr/bin/env", HERDR_PI_BIN: customPi }, run: stubRun(calls), randomNonce: () => "a".repeat(32) });
    await value.launchPiPane({ requestId: "r", cwd: await cwd(), runtime: "pi" });
    expect(calls.find((args) => args[0] === "pane")).toEqual(["pane", "run", "w:p1", customPi]);
  });
});

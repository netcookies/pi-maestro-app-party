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
      if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: "w1:p1", workspace_id: "w1" }, { pane_id: "w2:p1", workspace_id: "w2" }] } });
      return "{}";
    };
    const value = adapter(run);
    await value.sendCtrlD("w1:p1");
    await value.closeWorkspace("w1");
    expect(calls.at(-2)).toEqual(["pane", "send-keys", "w1:p1", "ctrl+d"]);
    expect(calls.at(-1)).toEqual(["workspace", "close", "w1"]);
    await expect(value.listPanes()).resolves.toEqual([{ paneId: "w1:p1", workspaceId: "w1" }, { paneId: "w2:p1", workspaceId: "w2" }]);
    await expect(value.sendCtrlD("bad;id")).rejects.toMatchObject({ stage: "validate_request" });
  });
});

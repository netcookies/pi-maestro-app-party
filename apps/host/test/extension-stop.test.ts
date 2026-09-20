import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stopManagedProcess } from "../src/extension.js";

describe("maestro-mobile extension managed process stop", () => {
  it("does not signal or remove a PID file for an unrelated process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-extension-stop-unknown-"));
    const pidFile = join(dir, "host.pid");
    const expectedCommand = "/opt/maestro/cli.js";
    await writeFile(pidFile, "41001\n");
    const signal = vi.fn();

    await expect(stopManagedProcess(pidFile, expectedCommand, {
      commandForPid: async () => `node /opt/unrelated/server.js --target ${expectedCommand}`,
      signal,
    })).resolves.toEqual({ pid: 41001, result: "not_owned" });

    expect(signal).not.toHaveBeenCalled();
    expect(await readFile(pidFile, "utf8")).toBe("41001\n");
  });

  it("signals a verified owner and only unlinks a PID file that still holds that PID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-extension-stop-owned-"));
    const expectedCommand = "/opt/maestro/cli.js";
    const signal = vi.fn();

    const unchangedPidFile = join(dir, "unchanged.pid");
    await writeFile(unchangedPidFile, "42001\n");
    await expect(stopManagedProcess(unchangedPidFile, expectedCommand, {
      commandForPid: async () => `node ${expectedCommand} --port 4739`,
      signal,
    })).resolves.toEqual({ pid: 42001, result: "signalled" });
    await expect(access(unchangedPidFile)).rejects.toThrow();

    const replacedPidFile = join(dir, "replaced.pid");
    await writeFile(replacedPidFile, "42002\n");
    let releaseCommand!: (command: string) => void;
    let commandRequested!: () => void;
    const requested = new Promise<void>((resolve) => { commandRequested = resolve; });
    const command = new Promise<string>((resolve) => { releaseCommand = resolve; });
    const stopping = stopManagedProcess(replacedPidFile, expectedCommand, {
      commandForPid: async () => {
        commandRequested();
        return command;
      },
      signal,
    });
    await requested;
    await writeFile(replacedPidFile, "42003\n");
    releaseCommand(`node ${expectedCommand} --port 4739`);

    await expect(stopping).resolves.toEqual({ pid: 42002, result: "signalled" });
    expect(await readFile(replacedPidFile, "utf8")).toBe("42003\n");
    expect(signal.mock.calls).toEqual([[42001], [42002]]);
  });
});

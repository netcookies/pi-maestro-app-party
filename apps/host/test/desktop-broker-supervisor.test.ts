import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DesktopBrokerSupervisor, isOwnedProcessCommand } from "../src/plugin/desktop-broker-supervisor.js";

async function waitForExit(pid: number): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} is still alive`);
}

describe("DesktopBrokerSupervisor", () => {
  let supervisor: DesktopBrokerSupervisor | undefined;

  it("resolves the default Broker CLI beside the plugin output directory", () => {
    const defaults = new DesktopBrokerSupervisor();
    const expected = fileURLToPath(new URL("../src/broker-cli.js", import.meta.url));

    expect(defaults.paths.brokerCliPath).toBe(expected);
  });

  afterEach(async () => {
    await supervisor?.stop();
    supervisor = undefined;
  });

  it("matches only the executable or Node script token on POSIX and Windows", () => {
    const posixExpected = "/opt/maestro/broker-cli.js";
    expect(isOwnedProcessCommand(`node ${posixExpected} --plugin-socket /tmp/plugin.sock`, posixExpected, "linux")).toBe(true);
    expect(isOwnedProcessCommand(`node /opt/other/server.js --target ${posixExpected}`, posixExpected, "linux")).toBe(false);
    expect(isOwnedProcessCommand(`${posixExpected} --plugin-socket /tmp/plugin.sock`, posixExpected, "linux")).toBe(true);

    const windowsExpected = "C:\\Program Files\\Maestro\\broker-cli.js";
    expect(isOwnedProcessCommand(`"C:\\Program Files\\nodejs\\node.exe" "${windowsExpected}" --plugin-socket plugin.sock`, windowsExpected, "win32")).toBe(true);
    expect(isOwnedProcessCommand(`node.exe other.js --target "${windowsExpected}"`, windowsExpected, "win32")).toBe(false);
  });

  it("does not trust a live unrelated PID from a stale pid file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-supervisor-stale-"));
    const pidFile = join(dir, "broker.pid");
    await writeFile(pidFile, `${process.pid}\n`);
    supervisor = new DesktopBrokerSupervisor({
      brokerCliPath: join(dir, "missing-broker.js"),
      pidFile,
      lockFile: join(dir, "broker.lock"),
      logFile: join(dir, "broker.log"),
    });
    expect(await supervisor.stop()).toBe(false);
    expect(await readFile(pidFile, "utf8")).toBe(`${process.pid}\n`);
  });

  it("starts one detached Broker owner, reuses its PID, and stops it explicitly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-broker-supervisor-"));
    const fakeBroker = join(dir, "fake-broker.cjs");
    await writeFile(fakeBroker, [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const pidFile = args[args.indexOf('--pid-file') + 1];",
      "fs.writeFileSync(pidFile, `${process.pid}\\n`);",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    supervisor = new DesktopBrokerSupervisor({
      brokerCliPath: fakeBroker,
      secretFile: join(dir, "secret"),
      pluginSocketPath: join(dir, "plugin.sock"),
      hostSocketPath: join(dir, "host.sock"),
      registryPath: join(dir, "registry.json"),
      pidFile: join(dir, "broker.pid"),
      lockFile: join(dir, "broker.lock"),
      logFile: join(dir, "broker.log"),
      restartIntervalMs: 20,
    });

    const firstPid = await supervisor.ensureRunning();
    expect(firstPid).toBeGreaterThan(0);
    expect(await supervisor.ensureRunning()).toBe(firstPid);
    expect(() => process.kill(firstPid, 0)).not.toThrow();
    expect(await supervisor.stop()).toBe(true);
    await waitForExit(firstPid);
    expect(await supervisor.stop()).toBe(false);
  });
});

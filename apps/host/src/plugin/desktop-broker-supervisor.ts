import { spawn, execFile } from "node:child_process";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DESKTOP_BROKER_PLUGIN_SOCKET = join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin.sock");
export const DEFAULT_DESKTOP_BROKER_HOST_SOCKET = join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-broker-host.sock");
export const DEFAULT_DESKTOP_BROKER_REGISTRY_FILE = join(homedir(), ".pi", "maestro-mobile", "ipc", "desktop-plugin-registry.json");
export const DEFAULT_DESKTOP_BROKER_PID_FILE = join(homedir(), ".pi", "maestro-mobile-broker.pid");
export const DEFAULT_DESKTOP_BROKER_LOCK_FILE = join(homedir(), ".pi", "maestro-mobile-broker.pid.lock");
export const DEFAULT_DESKTOP_BROKER_LOG_FILE = join(homedir(), ".pi", "maestro-mobile-broker.log");
export const DEFAULT_DESKTOP_BROKER_SECRET_FILE = join(homedir(), ".pi", "maestro-mobile-ipc-secret");

export interface DesktopBrokerSupervisorOptions {
  brokerCliPath?: string;
  secretFile?: string;
  pluginSocketPath?: string;
  hostSocketPath?: string;
  registryPath?: string;
  pidFile?: string;
  lockFile?: string;
  logFile?: string;
  restartIntervalMs?: number;
}

function tokenizePosixCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of commandLine) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\") escaped = true;
      else current += character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (escaped) current += "\\";
  if (started) args.push(current);
  return args;
}

/** Parse the argv quoting used by Win32 process command lines. */
function tokenizeWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  let index = 0;
  while (index < commandLine.length) {
    const character = commandLine[index];
    if ((character === " " || character === "\t") && !inQuotes) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      index += 1;
      continue;
    }
    if (character === "\\") {
      let slashes = 0;
      while (commandLine[index + slashes] === "\\") slashes += 1;
      if (commandLine[index + slashes] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          current += '"';
          started = true;
          index += slashes + 1;
        } else if (inQuotes && commandLine[index + slashes + 1] === '"') {
          current += '"';
          started = true;
          index += slashes + 2;
        } else {
          inQuotes = !inQuotes;
          started = true;
          index += slashes + 1;
        }
      } else {
        current += "\\".repeat(slashes);
        started = true;
        index += slashes;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      started = true;
      index += 1;
      continue;
    }
    current += character;
    started = true;
    index += 1;
  }
  if (started) args.push(current);
  return args;
}

function normalizeCommandPath(value: string, platform: NodeJS.Platform): string {
  const unquoted = value.trim().replace(/^(?:['"])(.*)(?:['"])$/, "$1");
  const normalized = platform === "win32" ? win32.normalize(unquoted) : posix.normalize(unquoted);
  const withoutTrailingSeparator = normalized.length > 1 ? normalized.replace(/[\\/]$/, "") : normalized;
  return platform === "win32" ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

function isNodeExecutable(value: string, platform: NodeJS.Platform): boolean {
  const name = value.split(platform === "win32" ? /[\\/]/ : "/").pop()?.toLowerCase();
  return name === "node" || name === "node.exe" || name === "nodejs" || name === "nodejs.exe";
}

/**
 * Check ownership by argv position, rather than accepting a path anywhere in a
 * process command line. The managed path is either the executable itself or
 * the script immediately invoked by a Node executable.
 */
export function isOwnedProcessCommand(
  commandLine: string,
  expectedCommandPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const args = platform === "win32"
    ? tokenizeWindowsCommandLine(commandLine)
    : tokenizePosixCommandLine(commandLine);
  if (args.length === 0 || expectedCommandPath.trim().length === 0) return false;
  const expected = normalizeCommandPath(expectedCommandPath, platform);
  if (normalizeCommandPath(args[0], platform) === expected) return true;
  return args.length > 1
    && isNodeExecutable(args[0], platform)
    && normalizeCommandPath(args[1], platform) === expected;
}

export class DesktopBrokerSupervisor {
  private readonly options: Required<DesktopBrokerSupervisorOptions>;
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private ensuring = false;
  private ensureTask: Promise<number> | undefined;
  private stopping = false;

  constructor(options: DesktopBrokerSupervisorOptions = {}) {
    this.options = {
      brokerCliPath: options.brokerCliPath ?? join(dirname(fileURLToPath(import.meta.url)), "..", "broker-cli.js"),
      secretFile: options.secretFile ?? DEFAULT_DESKTOP_BROKER_SECRET_FILE,
      pluginSocketPath: options.pluginSocketPath ?? DEFAULT_DESKTOP_BROKER_PLUGIN_SOCKET,
      hostSocketPath: options.hostSocketPath ?? DEFAULT_DESKTOP_BROKER_HOST_SOCKET,
      registryPath: options.registryPath ?? DEFAULT_DESKTOP_BROKER_REGISTRY_FILE,
      pidFile: options.pidFile ?? DEFAULT_DESKTOP_BROKER_PID_FILE,
      lockFile: options.lockFile ?? DEFAULT_DESKTOP_BROKER_LOCK_FILE,
      logFile: options.logFile ?? DEFAULT_DESKTOP_BROKER_LOG_FILE,
      restartIntervalMs: options.restartIntervalMs ?? 1_000,
    };
  }

  get paths(): Readonly<Required<DesktopBrokerSupervisorOptions>> {
    return this.options;
  }

  async ensureRunning(): Promise<number> {
    if (this.stopping) throw new Error("desktop broker supervisor is stopping");
    const current = await this.readPid();
    if (current !== null) {
      if (await this.isOwnedProcess(current)) return current;
      // A live PID owned by another process must remain untouched. Starting a
      // new Broker over it would overwrite the marker and make later stop unsafe.
      if (this.isProcessAlive(current)) throw new Error(`desktop broker pid ${current} is not owned`);
      await this.removeOwnedPid(current);
    }

    await mkdir(dirname(this.options.pidFile), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.options.pidFile), 0o700).catch(() => undefined);
    let lockAcquired = false;
    try {
      await writeExclusive(this.options.lockFile, String(process.pid));
      lockAcquired = true;
    } catch {
      const lockPid = await readNumber(this.options.lockFile);
      if (lockPid !== null && this.isProcessAlive(lockPid)) {
        throw new Error(`desktop broker startup already owned by pid ${lockPid}`);
      }
      await unlink(this.options.lockFile).catch(() => undefined);
      await writeExclusive(this.options.lockFile, String(process.pid));
      lockAcquired = true;
    }

    try {
      const afterLock = await this.readPid();
      if (this.stopping) throw new Error("desktop broker supervisor is stopping");
      if (afterLock !== null) {
        if (await this.isOwnedProcess(afterLock)) return afterLock;
        if (this.isProcessAlive(afterLock)) throw new Error(`desktop broker pid ${afterLock} is not owned`);
        await this.removeOwnedPid(afterLock);
      }
      if (this.stopping) throw new Error("desktop broker supervisor is stopping");
      const fd = await openLog(this.options.logFile);
      if (this.stopping) {
        if (fd !== undefined) closeSync(fd);
        throw new Error("desktop broker supervisor is stopping");
      }
      const child = spawn(process.execPath, [
        this.options.brokerCliPath,
        "--secret-file", this.options.secretFile,
        "--plugin-socket", this.options.pluginSocketPath,
        "--host-socket", this.options.hostSocketPath,
        "--registry", this.options.registryPath,
        "--pid-file", this.options.pidFile,
      ], {
        detached: true,
        stdio: fd === undefined ? "ignore" : ["ignore", fd, fd],
      });
      if (fd !== undefined) closeSync(fd);
      if (child.pid === undefined) throw new Error("desktop broker spawn returned no pid");
      child.unref();
      await writeFile0600(this.options.pidFile, String(child.pid));
      return child.pid;
    } finally {
      if (lockAcquired) await unlink(this.options.lockFile).catch(() => undefined);
    }
  }

  startWatch(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      if (this.ensuring) return;
      this.ensuring = true;
      const task = this.ensureRunning();
      this.ensureTask = task;
      void task.catch((error: unknown) => {
        if (!this.stopping) void appendLog(this.options.logFile, `supervisor restart failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        this.ensuring = false;
        if (this.ensureTask === task) this.ensureTask = undefined;
      });
    }, this.options.restartIntervalMs);
  }

  stopWatch(): void {
    if (!this.watchTimer) return;
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  async stop(): Promise<boolean> {
    this.stopping = true;
    this.stopWatch();
    await this.ensureTask?.catch(() => undefined);
    const pid = await this.readPid();
    if (pid === null) return false;
    if (!(await this.isOwnedProcess(pid))) return false;
    try { process.kill(pid, "SIGTERM"); } catch { /* process exited between probe and kill */ }
    await waitForExit(pid, 2_000, () => this.isProcessAlive(pid));
    await this.removeOwnedPid(pid);
    return true;
  }

  private async readPid(): Promise<number | null> {
    return readNumber(this.options.pidFile);
  }

  private async removeOwnedPid(pid: number): Promise<void> {
    const current = await this.readPid();
    if (current === pid) await unlink(this.options.pidFile).catch(() => undefined);
  }

  private async isOwnedProcess(pid: number): Promise<boolean> {
    if (!this.isProcessAlive(pid)) return false;
    try {
      const command = await processCommand(pid);
      return isOwnedProcessCommand(command, this.options.brokerCliPath);
    } catch {
      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function processCommand(pid: number): Promise<string> {
  const invocation = process.platform === "win32"
    ? {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }`,
      ],
    }
    : { file: "ps", args: ["-p", String(pid), "-o", "command="] };
  return new Promise((resolve, reject) => {
    execFile(invocation.file, invocation.args, { windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function writeExclusive(path: string, value: string): Promise<void> {
  await writeFile0600(path, value, "wx");
}

async function writeFile0600(path: string, value: string, flag?: "wx"): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${value}\n`, flag ? { flag, mode: 0o600 } : { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readNumber(path: string): Promise<number | null> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function openLog(path: string): Promise<number | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a", 0o600);
    await chmod(path, 0o600);
    return fd;
  } catch {
    return undefined;
  }
}

async function appendLog(path: string, message: string): Promise<void> {
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Broker restart diagnostics are best effort.
  }
}

async function waitForExit(pid: number, timeoutMs: number, isAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive()) await new Promise((resolve) => setTimeout(resolve, 50));
  if (isAlive()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

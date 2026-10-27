import { execFile as execFileCallback } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFile = promisify(execFileCallback);
export const HERDR_MIN_VERSION = "0.9.5";
export const HERDR_API_PROTOCOL = 22;
export const HERDR_LAUNCH_NONCE_ENV = "MAESTRO_HERDR_LAUNCH_NONCE";
export const HERDR_PROBE_TIMEOUT_MS = 1_500;
export const HERDR_OPERATION_TIMEOUT_MS = 10_000;

export type HerdrAvailability = "available" | "not_installed" | "not_running" | "incompatible" | "degraded";
export type HerdrErrorCode = "herdr_not_installed" | "herdr_not_running" | "herdr_incompatible" | "herdr_operation_failed";

export interface HerdrServerStatus {
  status: HerdrAvailability;
  running: boolean;
  version?: string;
  protocol?: number;
  capabilities?: string[];
}

export interface HerdrPaneLaunch {
  requestId: string;
  cwd: string;
  label?: string;
  /** 历史 JSONL 绝对路径；经 realpath 验证后拼 --session（--resume 是无参布尔，不能带 id） */
  resumeSessionRef?: string;
  /** 显式选择运行时；缺省按 pi */
  runtime?: "pi" | "pi-bolt";
}

export interface HerdrPaneLaunchResult {
  paneId: string;
  workspaceId?: string;
  launchNonce: string;
}

export interface HerdrRuntimeProbe {
  pi: boolean;
  piBolt: boolean;
}

export interface HerdrPaneSummary {
  paneId: string;
  workspaceId?: string;
}

export class HerdrAdapterError extends Error {
  constructor(
    readonly code: HerdrErrorCode,
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrAdapterError";
  }
}

export interface HerdrAdapterOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<string>;
  randomNonce?: () => string;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.replace(/^v/, "").split(".").slice(0, 3).map((part) => Number(part));
  const left = parse(actual);
  const right = parse(minimum);
  if (left.length !== 3 || right.length !== 3 || [...left, ...right].some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return true;
}

function parseStatus(output: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function validLabel(label: string | undefined): boolean {
  // `:` 允许 `mm:<name>` 前缀（Host 启动的 space 标识）
  return label === undefined || (label.length > 0 && label.length <= 80 && /^[\p{L}\p{N} .:_-]+$/u.test(label));
}

function validNonce(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function validPaneId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[\w:.\-]+$/u.test(value);
}

/** 与协议层 isValidSessionRefPath 同语义的 Host 侧复检（协议已拦，此处防御） */
function isValidSessionRef(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value.startsWith("/")
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value.split("/").every((segment) => segment !== "..");
}

export class HerdrAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly run: NonNullable<HerdrAdapterOptions["run"]>;
  private readonly randomNonce: () => string;
  private binary: string | undefined;

  constructor(options: HerdrAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? HERDR_OPERATION_TIMEOUT_MS;
    this.run = options.run ?? (async (binary, args, runOptions) => {
      const result = await execFile(binary, args, { env: runOptions.env, timeout: runOptions.timeout, maxBuffer: 1024 * 1024, encoding: "utf8" });
      return result.stdout;
    });
    this.randomNonce = options.randomNonce ?? (() => randomBytes(16).toString("hex"));
  }

  async probe(): Promise<HerdrServerStatus> {
    const binary = await this.resolveBinary();
    if (!binary) return { status: "not_installed", running: false };
    let output: string;
    try {
      output = await this.run(binary, ["status", "server", "--json"], { env: this.env, timeout: HERDR_PROBE_TIMEOUT_MS });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Herdr status command failed";
      if (/not running|connection refused|no such file|connect/i.test(message)) return { status: "not_running", running: false };
      return { status: "degraded", running: false };
    }
    const value = parseStatus(output);
    if (!value || typeof value.running !== "boolean" || typeof value.status !== "string") return { status: "degraded", running: false };
    if (!value.running || value.status === "not_running") return { status: "not_running", running: false };
    if (typeof value.version !== "string" || !versionAtLeast(value.version, HERDR_MIN_VERSION)
      || value.protocol !== HERDR_API_PROTOCOL || value.compatible !== true) {
      return {
        status: "incompatible",
        running: true,
        ...(typeof value.version === "string" ? { version: value.version } : {}),
        ...(typeof value.protocol === "number" ? { protocol: value.protocol } : {}),
        ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities.filter((item): item is string => typeof item === "string") } : {}),
      };
    }
    return {
      status: "available",
      running: true,
      version: value.version,
      protocol: value.protocol,
      ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities.filter((item): item is string => typeof item === "string") } : {}),
    };
  }

  async launchPiPane(request: HerdrPaneLaunch): Promise<HerdrPaneLaunchResult> {
    const cwd = await this.validateCwd(request.cwd);
    if (!validLabel(request.label)) throw new HerdrAdapterError("herdr_operation_failed", "validate_request", "Invalid workspace label");
    let sessionRef: string | undefined;
    if (request.resumeSessionRef !== undefined) {
      if (!isValidSessionRef(request.resumeSessionRef)) throw new HerdrAdapterError("herdr_operation_failed", "validate_request", "Invalid resume session ref");
      try {
        sessionRef = await realpath(request.resumeSessionRef);
      } catch {
        throw new HerdrAdapterError("herdr_operation_failed", "validate_request", "Resume session file does not exist");
      }
    }
    const status = await this.probe();
    if (status.status === "not_installed") throw new HerdrAdapterError("herdr_not_installed", "probe", "Herdr is not installed");
    if (status.status === "not_running") throw new HerdrAdapterError("herdr_not_running", "probe", "Herdr server is not running");
    if (status.status === "incompatible") throw new HerdrAdapterError("herdr_incompatible", "probe", "Herdr version or API protocol is incompatible");
    if (status.status !== "available") throw new HerdrAdapterError("herdr_operation_failed", "probe", "Herdr status could not be verified");

    const binary = this.binary!;
    const nonce = this.randomNonce();
    if (!validNonce(nonce)) throw new HerdrAdapterError("herdr_operation_failed", "create_pane", "Nonce generator returned an invalid value");
    const createArgs = ["workspace", "create", "--cwd", cwd, "--env", `${HERDR_LAUNCH_NONCE_ENV}=${nonce}`, "--no-focus"];
    if (request.label) createArgs.push("--label", request.label);
    const workspaceOutput = await this.invoke(binary, createArgs, "create_pane");
    const workspaceResult = parseStatus(workspaceOutput);
    const paneId = this.rootPaneId(workspaceResult);
    if (!paneId) throw new HerdrAdapterError("herdr_operation_failed", "create_pane", "Herdr did not return a root pane id");
    const workspaceId = this.workspaceIdOf(workspaceResult);
    const runtimeBinary = request.runtime === "pi-bolt" ? "pi-bolt" : "pi";
    const runArgs = ["pane", "run", paneId, runtimeBinary];
    if (sessionRef) runArgs.push("--session", sessionRef);
    await this.invoke(binary, runArgs, "start_pi");
    return { paneId, workspaceId, launchNonce: nonce };
  }

  /** 探测 pi / pi-bolt 可执行性（HERDR_PI_BOLT_BIN 覆盖 → PATH） */
  async probeRuntimes(): Promise<HerdrRuntimeProbe> {
    const pi = await this.findExecutable(this.env.HERDR_PI_BIN ?? "pi");
    const piBolt = await this.findExecutable(this.env.HERDR_PI_BOLT_BIN ?? "pi-bolt");
    return { pi, piBolt };
  }

  async sendCtrlD(paneId: string): Promise<void> {
    if (!validPaneId(paneId)) throw new HerdrAdapterError("herdr_operation_failed", "validate_request", "Invalid pane id");
    const binary = await this.resolveBinary();
    if (!binary) throw new HerdrAdapterError("herdr_not_installed", "probe", "Herdr is not installed");
    await this.invoke(binary, ["pane", "send-keys", paneId, "ctrl+d"], "send_keys");
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    if (!validPaneId(workspaceId)) throw new HerdrAdapterError("herdr_operation_failed", "validate_request", "Invalid workspace id");
    const binary = await this.resolveBinary();
    if (!binary) throw new HerdrAdapterError("herdr_not_installed", "probe", "Herdr is not installed");
    await this.invoke(binary, ["workspace", "close", workspaceId], "close_workspace");
  }

  async listPanes(): Promise<HerdrPaneSummary[]> {
    const binary = await this.resolveBinary();
    if (!binary) throw new HerdrAdapterError("herdr_not_installed", "probe", "Herdr is not installed");
    const output = await this.invoke(binary, ["pane", "list"], "list_panes");
    const value = parseStatus(output);
    const panes = typeof value?.result === "object" && value.result !== null && Array.isArray((value.result as Record<string, unknown>).panes)
      ? (value.result as { panes: unknown[] }).panes
      : [];
    return panes.flatMap((entry) => {
      if (!isRecord(entry) || !isString(entry.pane_id)) return [];
      return [{ paneId: entry.pane_id, ...(isString(entry.workspace_id) ? { workspaceId: entry.workspace_id } : {}) }];
    });
  }

  private async findExecutable(name: string): Promise<boolean> {
    if (name.includes("/")) {
      try {
        await access(name);
        return true;
      } catch {
        return false;
      }
    }
    for (const directory of (this.env.PATH ?? "").split(delimiter)) {
      try {
        await access(`${directory}/${name}`);
        return true;
      } catch {
        // Continue searching PATH.
      }
    }
    return false;
  }

  private async resolveBinary(): Promise<string | undefined> {
    if (this.binary) return this.binary;
    const explicit = this.env.HERDR_BIN_PATH;
    if (explicit) {
      try {
        await access(explicit);
        this.binary = explicit;
        return explicit;
      } catch {
        return undefined;
      }
    }
    for (const directory of (this.env.PATH ?? "").split(delimiter)) {
      const candidate = `${directory}/herdr`;
      try {
        await access(candidate);
        this.binary = candidate;
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
    return undefined;
  }

  private async validateCwd(cwd: string): Promise<string> {
    if (!isAbsolute(cwd) || cwd.length > 4096 || /[\u0000-\u001f]/.test(cwd)) {
      throw new HerdrAdapterError("herdr_operation_failed", "validate_cwd", "cwd must be an absolute path without control characters");
    }
    try {
      return await realpath(cwd);
    } catch {
      throw new HerdrAdapterError("herdr_operation_failed", "validate_cwd", "cwd does not exist");
    }
  }

  private async invoke(binary: string, args: string[], stage: string): Promise<string> {
    try {
      return await this.run(binary, args, { env: this.env, timeout: this.timeoutMs });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 256) : "Herdr command failed";
      throw new HerdrAdapterError("herdr_operation_failed", stage, reason);
    }
  }

  private rootPaneId(value: Record<string, unknown> | undefined): string | undefined {
    if (!value) return undefined;
    const result = typeof value.result === "object" && value.result !== null ? value.result as Record<string, unknown> : value;
    const pane = typeof result.root_pane === "object" && result.root_pane !== null ? result.root_pane as Record<string, unknown> : undefined;
    const paneId = pane?.pane_id ?? pane?.id ?? result.root_pane_id;
    return typeof paneId === "string" && paneId.length > 0 && paneId.length <= 128 ? paneId : undefined;
  }

  private workspaceIdOf(value: Record<string, unknown> | undefined): string | undefined {
    if (!value) return undefined;
    const result = typeof value.result === "object" && value.result !== null ? value.result as Record<string, unknown> : value;
    const workspace = typeof result.workspace === "object" && result.workspace !== null ? result.workspace as Record<string, unknown> : undefined;
    const pane = typeof result.root_pane === "object" && result.root_pane !== null ? result.root_pane as Record<string, unknown> : undefined;
    const workspaceId = workspace?.workspace_id ?? pane?.workspace_id ?? result.workspace_id;
    return typeof workspaceId === "string" && workspaceId.length > 0 && workspaceId.length <= 128 ? workspaceId : undefined;
  }
}

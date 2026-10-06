import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionUiResponse } from "@maestro-mobile/shared";
import { createAskResponseTempFilename, resolveAskResponsePath } from "./ask-response-file.js";

export interface FlowAskResult {
  status: "accepted" | "failed";
  error?: { code: string };
  path?: string;
}

interface PendingAsk {
  invalidated?: "cancelled";
}

export interface DesktopFlowAskAdapterOptions {
  toolNames: readonly string[];
  responseDirectory?: string;
}

function responseDirectoryFrom(options: DesktopFlowAskAdapterOptions): string | undefined {
  const configuredDirectory = options.responseDirectory ?? "/tmp";
  return isAbsolute(configuredDirectory) ? configuredDirectory : undefined;
}

export class DesktopFlowAskAdapter {
  readonly supported: boolean;
  private readonly pending = new Map<string, PendingAsk>();
  private readonly inFlight = new Set<Promise<FlowAskResult>>();
  private readonly writeTails = new Map<string, Promise<FlowAskResult>>();
  private readonly responseDirectory: string | undefined;

  constructor(options: DesktopFlowAskAdapterOptions) {
    this.supported = options.toolNames.includes("ask-user-question");
    this.responseDirectory = responseDirectoryFrom(options);
  }

  static fromTools(tools: readonly { name?: string }[]): DesktopFlowAskAdapter {
    return new DesktopFlowAskAdapter({ toolNames: tools.map((tool) => tool.name ?? "") });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  register(toolCallId: string, _questions: unknown[]): boolean {
    if (!this.supported || !this.responseDirectory || !resolveAskResponsePath(toolCallId, this.responseDirectory)) return false;
    const previous = this.pending.get(toolCallId);
    if (previous) {
      previous.invalidated = "cancelled";
      this.removePending(toolCallId);
    }
    this.pending.set(toolCallId, {});
    return true;
  }

  async answer(toolCallId: string, response: ExtensionUiResponse): Promise<FlowAskResult> {
    if (!this.supported) return { status: "failed", error: { code: "unsupported_capability" } };
    const pending = this.pending.get(toolCallId);
    if (!pending) return { status: "failed", error: { code: "request_not_found" } };
    const path = this.responsePath(toolCallId);
    if (!path || !this.responseDirectory) return { status: "failed", error: { code: "request_not_found" } };
    const operation = this.enqueueResponse(path, () => this.writeResponse(toolCallId, pending, response, path));
    this.inFlight.add(operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(operation);
    }
  }

  private enqueueResponse(path: string, write: () => Promise<FlowAskResult>): Promise<FlowAskResult> {
    const previous = this.writeTails.get(path);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(write);
    this.writeTails.set(path, operation);
    void operation.finally(() => {
      if (this.writeTails.get(path) === operation) this.writeTails.delete(path);
    }).catch(() => undefined);
    return operation;
  }

  private async writeResponse(toolCallId: string, pending: PendingAsk, response: ExtensionUiResponse, path: string): Promise<FlowAskResult> {
    const temporary = join(this.responseDirectory!, createAskResponseTempFilename());
    try {
      const content = JSON.stringify(response);
      await mkdir(this.responseDirectory!, { recursive: true, mode: 0o700 });
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      if (!this.isActivePending(toolCallId, pending)) {
        await unlink(temporary).catch(() => undefined);
        if (!pending.invalidated && this.pending.get(toolCallId) === pending) this.removePending(toolCallId);
        return { status: "failed", error: { code: pending.invalidated ? "request_cancelled" : "request_not_found" } };
      }
      await rename(temporary, path);
      if (!this.isActivePending(toolCallId, pending)) {
        await unlink(path).catch(() => undefined);
        if (!pending.invalidated && this.pending.get(toolCallId) === pending) this.removePending(toolCallId);
        return { status: "failed", error: { code: pending.invalidated ? "request_cancelled" : "request_not_found" } };
      }
      this.removePending(toolCallId);
      return { status: "accepted", path };
    } catch {
      await unlink(temporary).catch(() => undefined);
      return { status: "failed", error: { code: "response_write_failed" } };
    }
  }

  async cancelAll(): Promise<void> {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (pending) pending.invalidated = "cancelled";
      this.removePending(id);
    }
    await Promise.all([...this.inFlight]);
    for (const id of ids) {
      const path = this.responsePath(id);
      if (path) await unlink(path).catch(() => undefined);
    }
  }

  private isActivePending(toolCallId: string, pending: PendingAsk): boolean {
    if (this.pending.get(toolCallId) !== pending || pending.invalidated) return false;
    return true;
  }

  private responsePath(toolCallId: string): string | undefined {
    return this.responseDirectory ? resolveAskResponsePath(toolCallId, this.responseDirectory) : undefined;
  }

  private removePending(toolCallId: string): void {
    this.pending.delete(toolCallId);
  }
}

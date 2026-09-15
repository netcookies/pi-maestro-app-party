import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionUiResponse } from "@maestro-mobile/shared";

export interface FlowAskResult {
  status: "accepted" | "failed";
  error?: { code: string };
  path?: string;
}

interface PendingAsk {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface DesktopFlowAskAdapterOptions {
  toolNames: readonly string[];
  responseDirectory?: string;
  ttlMs?: number;
  now?: () => number;
}

function safeToolCallId(toolCallId: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(toolCallId);
}

export class DesktopFlowAskAdapter {
  readonly supported: boolean;
  private readonly pending = new Map<string, PendingAsk>();
  private readonly responseDirectory: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DesktopFlowAskAdapterOptions) {
    this.supported = options.toolNames.includes("ask-user-question");
    this.responseDirectory = options.responseDirectory ?? "/tmp";
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  static fromTools(tools: readonly { name?: string }[]): DesktopFlowAskAdapter {
    return new DesktopFlowAskAdapter({ toolNames: tools.map((tool) => tool.name ?? "") });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  register(toolCallId: string, _questions: unknown[], expiresAt = this.now() + this.ttlMs): boolean {
    if (!this.supported || !safeToolCallId(toolCallId)) return false;
    this.expire();
    this.removePending(toolCallId);
    const boundedExpiry = Math.min(expiresAt, this.now() + this.ttlMs);
    const timer = setTimeout(() => {
      this.removePending(toolCallId);
    }, Math.max(1, boundedExpiry - this.now()));
    timer.unref?.();
    this.pending.set(toolCallId, { expiresAt: boundedExpiry, timer });
    return true;
  }

  async answer(toolCallId: string, response: ExtensionUiResponse): Promise<FlowAskResult> {
    this.expire();
    if (!this.supported) return { status: "failed", error: { code: "unsupported_capability" } };
    if (!safeToolCallId(toolCallId)) return { status: "failed", error: { code: "request_not_found" } };
    const pending = this.pending.get(toolCallId);
    if (!pending) return { status: "failed", error: { code: "request_not_found" } };
    if (pending.expiresAt <= this.now()) {
      this.removePending(toolCallId);
      return { status: "failed", error: { code: "request_timeout" } };
    }
    const path = this.responsePath(toolCallId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const content = JSON.stringify(response);
      await mkdir(this.responseDirectory, { recursive: true });
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
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
      this.removePending(id);
      await unlink(this.responsePath(id)).catch(() => undefined);
    }
  }

  private responsePath(toolCallId: string): string {
    return join(this.responseDirectory, `pi-ask-response-${toolCallId}.json`);
  }

  private expire(): void {
    const now = this.now();
    for (const [toolCallId, pending] of this.pending) {
      if (pending.expiresAt <= now) this.removePending(toolCallId);
    }
  }

  private removePending(toolCallId: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
  }
}

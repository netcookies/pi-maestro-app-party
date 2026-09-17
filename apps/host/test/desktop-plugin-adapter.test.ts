import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPluginRequest } from "@maestro-mobile/shared";
import { DesktopFlowAskAdapter } from "../src/plugin/desktop-flow-ask-adapter.js";
import { DesktopPiSessionAdapter, deliveryFailure } from "../src/plugin/desktop-pi-session-adapter.js";

const target = {
  sessionId: "session-1",
  endpointId: "desktop-1",
  normalizedCwd: "/work/app",
  processGeneration: "generation-1",
};

function request(operation: DesktopPluginRequest["operation"]): DesktopPluginRequest {
  return {
    type: "desktop_plugin_request",
    requestId: "request-1",
    commandId: "command-1",
    deadlineAt: Date.now() + 1000,
    target,
    operation,
  };
}

describe("DesktopFlowAskAdapter", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(async (dir) => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it("writes only the exact toolCallId file atomically with 0600 permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-"));
    dirs.push(dir);
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir });
    expect(adapter.register("call-123", [{ question: "Continue?" }])).toBe(true);
    const result = await adapter.answer("call-123", { selected: ["yes"] });
    expect(result.status).toBe("accepted");
    expect(result.path).toBe(join(dir, "pi-ask-response-call-123.json"));
    expect(JSON.parse(await readFile(result.path!, "utf8"))).toEqual({ selected: ["yes"] });
    expect((await stat(result.path!)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["pi-ask-response-call-123.json"]);
  });

  it("does not create a file when Flow ask is unavailable or the request is stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-unsupported-"));
    dirs.push(dir);
    const unsupported = new DesktopFlowAskAdapter({ toolNames: [], responseDirectory: dir });
    expect(unsupported.register("call-1", [])).toBe(false);
    await expect(unsupported.answer("call-1", { value: "no" })).resolves.toMatchObject({ status: "failed", error: { code: "unsupported_capability" } });
    expect(await readdir(dir)).toEqual([]);

    let now = 1000;
    const stale = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir, now: () => now, ttlMs: 10 });
    stale.register("call-2", [], 1005);
    now = 1006;
    await expect(stale.answer("call-2", { value: "late" })).resolves.toMatchObject({ status: "failed", error: { code: "request_not_found" } });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("DesktopPiSessionAdapter", () => {
  it("calls the injected same-process abort and cancels pending ask", async () => {
    let aborts = 0;
    const ask = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: "/tmp" });
    ask.register("call-abort", []);
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: () => { aborts += 1; },
      getAllTools: () => [{ name: "ask-user-question" }],
    }, target, ask);

    const result = await adapter.execute(request({ type: "abort" }));

    expect(result.status).toBe("observed");
    expect(aborts).toBe(1);
    expect(ask.pendingCount).toBe(0);
  });

  it("invokes the same-process model switch with provider and id", async () => {
    const calls: Array<[string | undefined, string]> = [];
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      setModel: async (provider, modelId) => {
        calls.push([provider, modelId]);
        return true;
      },
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "set_model", provider: "provider-a", modelId: "shared-id" }))).resolves.toMatchObject({
      status: "observed",
    });
    expect(calls).toEqual([["provider-a", "shared-id"]]);
  });

  it("reports model_change_failed when Pi rejects the selected model", async () => {
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      setModel: async () => false,
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "set_model", provider: "provider-a", modelId: "missing" }))).resolves.toMatchObject({
      status: "failed",
      error: { code: "model_change_failed" },
    });
  });

  it("preserves a structured delivery code instead of flattening it", async () => {
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => { throw deliveryFailure("no_model_selected"); },
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      setModel: async () => true,
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "prompt", message: "hello" }))).resolves.toMatchObject({
      status: "failed",
      // code 稳定可判别；原因走 message，便于诊断且不破坏机器可读性。
      error: { code: "delivery_failed", message: "no_model_selected" },
    });
  });

  it("falls back to a generic code when the thrown error carries none", async () => {
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => { throw new Error("boom"); },
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      setModel: async () => true,
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "prompt", message: "hello" }))).resolves.toMatchObject({
      status: "failed",
      error: { code: "plugin_command_failed" },
    });
  });

  it("rejects stale target identity before invoking Pi", async () => {
    let prompts = 0;
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => { prompts += 1; },
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      getAllTools: () => [],
    }, target);
    const result = await adapter.execute({ ...request({ type: "prompt", message: "hello" }), target: { ...target, processGeneration: "stale" } });
    expect(result.error?.code).toBe("target_mismatch");
    expect(prompts).toBe(0);
  });
});

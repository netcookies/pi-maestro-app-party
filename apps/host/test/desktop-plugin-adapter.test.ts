import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopPluginRequest } from "@maestro-mobile/shared";
import { createAskResponseTempFilename, resolveAskResponseFilename, resolveAskResponsePath } from "../src/plugin/ask-response-file.js";
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
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it("maps observed provider IDs to the legacy consumer filename", () => {
    expect(resolveAskResponseFilename("call_a|fc_b")).toBe("pi-ask-response-call_a|fc_b.json");
    expect(resolveAskResponseFilename("call_a:fc-b.1|fc_2")).toBe("pi-ask-response-call_a:fc-b.1|fc_2.json");
  });

  it("accepts the 219-byte boundary and rejects unsafe IDs", () => {
    const accepted = "a".repeat(219);
    const filename = resolveAskResponseFilename(accepted);
    expect(filename).toBeDefined();
    expect(Buffer.byteLength(filename!, "utf8")).toBe(240);
    expect(resolveAskResponseFilename("a".repeat(220))).toBeUndefined();
    for (const value of ["", ".", "..", "../x", "..\\x", "a/b", "a\\b", `x\0y`, "x\ny", "call id", "é"]) {
      expect(resolveAskResponseFilename(value), JSON.stringify(value)).toBeUndefined();
    }
    expect(resolveAskResponsePath("call", "relative")).toBeUndefined();
    expect(resolveAskResponsePath("call", `/tmp/ask\0bridge`)).toBeUndefined();
    const temporary = createAskResponseTempFilename();
    expect(Buffer.byteLength(temporary, "utf8")).toBeLessThanOrEqual(64);
    expect(temporary).toMatch(/^pi-ask-response-tmp-[0-9a-f-]+\.tmp$/);
  });

  it("writes the exact legacy toolCallId file atomically with 0600 permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-"));
    dirs.push(dir);
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir });
    const raw = "call_123|fc_456";
    expect(adapter.register(raw, [{ question: "Continue?" }])).toBe(true);
    const result = await adapter.answer(raw, { selected: ["yes"] });
    expect(result.status).toBe("accepted");
    expect(result.path).toBe(join(dir, `pi-ask-response-${raw}.json`));
    expect(JSON.parse(await readFile(result.path!, "utf8"))).toEqual({ selected: ["yes"] });
    expect((await stat(result.path!)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([`pi-ask-response-${raw}.json`]);
  });

  it("rejects unsafe registrations without creating response files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-adversarial-"));
    dirs.push(dir);
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir });
    for (const raw of ["../x", "..\\x", "a/b", "a\\b", `x\0y`, "x\u001fy", "x\ny", "call id", "é"]) {
      expect(adapter.register(raw, []), JSON.stringify(raw)).toBe(false);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("retains pending state after write failure and accepts the identical retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "maestro-ask-retry-"));
    dirs.push(root);
    const dir = join(root, "responses");
    await writeFile(dir, "blocks-directory-creation", "utf8");
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir });
    const raw = "call_retry|fc_retry";
    expect(adapter.register(raw, [])).toBe(true);
    await expect(adapter.answer(raw, { selected: ["first"] })).resolves.toMatchObject({ status: "failed", error: { code: "response_write_failed" } });
    expect(adapter.pendingCount).toBe(1);
    await rm(dir);
    await mkdir(dir);
    await expect(adapter.answer(raw, { selected: ["retry"] })).resolves.toMatchObject({ status: "accepted" });
    expect(adapter.pendingCount).toBe(0);
    const entries = await readdir(dir);
    expect(entries).toEqual([resolveAskResponseFilename(raw)]);
    expect(JSON.parse(await readFile(join(dir, entries[0]), "utf8"))).toEqual({ selected: ["retry"] });
  });

  it("rejects a response that crosses expiry during asynchronous writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-inflight-expiry-"));
    dirs.push(dir);
    let nowCalls = 0;
    const adapter = new DesktopFlowAskAdapter({
      toolNames: ["ask-user-question"],
      responseDirectory: dir,
      now: () => { nowCalls += 1; return nowCalls <= 5 ? 1000 : 1002; },
    });
    const raw = "call_inflight|fc_expiry";
    expect(adapter.register(raw, [], 1001)).toBe(true);
    await expect(adapter.answer(raw, { selected: ["late"] })).resolves.toMatchObject({ status: "failed", error: { code: "request_timeout" } });
    expect(adapter.pendingCount).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("waits for in-flight writes before cancelAll returns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-cancel-race-"));
    dirs.push(dir);
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir });
    expect(adapter.register("call_cancel|fc_race", [])).toBe(true);
    const answer = adapter.answer("call_cancel|fc_race", { selected: ["cancel"] });
    await adapter.cancelAll();
    await answer;
    expect(adapter.pendingCount).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a newer registration's response when generations overlap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-ask-generation-race-"));
    dirs.push(dir);
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: dir });
    const raw = "call_generation|fc_race";
    expect(adapter.register(raw, [])).toBe(true);
    const first = adapter.answer(raw, { selected: ["first"] });
    expect(adapter.register(raw, [])).toBe(true);
    const second = adapter.answer(raw, { selected: ["second"] });
    await Promise.all([first, second]);
    expect(adapter.pendingCount).toBe(0);
    expect(JSON.parse(await readFile(join(dir, resolveAskResponseFilename(raw)!), "utf8"))).toEqual({ selected: ["second"] });
  });

  it("ignores PI_ASK_RESPONSE_DIR when using the unchanged Flow consumer", async () => {
    const previous = process.env.PI_ASK_RESPONSE_DIR;
    process.env.PI_ASK_RESPONSE_DIR = "relative-override";
    try {
      const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"] });
      expect(adapter.register("call_env|fc_override", [])).toBe(true);
      await adapter.cancelAll();
    } finally {
      if (previous === undefined) delete process.env.PI_ASK_RESPONSE_DIR;
      else process.env.PI_ASK_RESPONSE_DIR = previous;
    }
  });

  it("fails closed for relative response directories", () => {
    const adapter = new DesktopFlowAskAdapter({ toolNames: ["ask-user-question"], responseDirectory: "relative" });
    expect(adapter.register("call-1", [])).toBe(false);
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

  it("reports accepted instead of observed for fire-and-forget user delivery", async () => {
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "prompt", message: "hello" }))).resolves.toMatchObject({
      status: "accepted",
    });
  });
  it("reports accepted for steer and follow-up fire-and-forget delivery", async () => {
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "steer", message: "interrupt" }))).resolves.toMatchObject({ status: "accepted" });
    await expect(adapter.execute(request({ type: "follow_up", message: "after" }))).resolves.toMatchObject({ status: "accepted" });
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

  it("invokes the same-process thinking switch", async () => {
    const calls: string[] = [];
    const adapter = new DesktopPiSessionAdapter({
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: () => {},
      setModel: async () => true,
      setThinking: (level) => { calls.push(level); },
      getAllTools: () => [],
    }, target);

    await expect(adapter.execute(request({ type: "set_thinking", level: "high" }))).resolves.toMatchObject({
      status: "accepted",
    });
    expect(calls).toEqual(["high"]);
    expect(adapter.getCapabilities()).toContain("set_thinking");
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

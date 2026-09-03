import { describe, expect, it, beforeEach } from "vitest";
import { ExtensionUiQueue } from "../src/extension-ui-queue.js";
import type { ExtensionUiRequest } from "@maestro-mobile/shared";

function makeRequest(overrides: Partial<ExtensionUiRequest> = {}): ExtensionUiRequest {
  return {
    id: `req-${Math.random()}`,
    sessionId: "s1",
    method: "select",
    title: "Pick",
    options: ["A", "B"],
    ...overrides,
  };
}

describe("ExtensionUiQueue", () => {
  let queue: ExtensionUiQueue;

  beforeEach(() => {
    queue = new ExtensionUiQueue();
  });

  it("enqueues and lists pending dialogs", () => {
    const req = makeRequest();
    queue.enqueue(req);
    expect(queue.count).toBe(1);
    expect(queue.pendingDialogs[0].request.id).toBe(req.id);
  });

  it("answers a dialog and returns response", () => {
    const req = makeRequest({ method: "select" });
    queue.enqueue(req);
    const response = queue.answer(req.id, { selected: ["B"] });
    expect(response).toEqual({ id: req.id, selected: ["B"] });
    expect(queue.count).toBe(0);
  });

  it("cancels a dialog", () => {
    const req = makeRequest();
    queue.enqueue(req);
    const response = queue.cancel(req.id);
    expect(response).toEqual({ id: req.id, cancelled: true });
    expect(queue.count).toBe(0);
  });

  it("ignores answer to unknown dialog", () => {
    expect(queue.answer("unknown", { selected: ["A"] })).toBeUndefined();
  });

  it("expires dialogs after timeout", () => {
    let now = 1000;
    queue = new ExtensionUiQueue({ defaultTimeoutMs: 5000, now: () => now });
    const req = makeRequest();
    queue.enqueue(req);
    expect(queue.count).toBe(1);

    now = 7000;
    expect(queue.count).toBe(0);
    expect(queue.get(req.id)?.status).toBe("expired");
  });

  it("respects per-request timeout override", () => {
    let now = 1000;
    queue = new ExtensionUiQueue({ defaultTimeoutMs: 5000, now: () => now });
    const req = makeRequest({ timeout: 1000 });
    queue.enqueue(req);
    now = 3000; // 超过 1000ms 但不到默认 5000ms
    expect(queue.count).toBe(0);
  });

  it("clears session dialogs", () => {
    const req1 = makeRequest({ id: "r1", sessionId: "s1" });
    const req2 = makeRequest({ id: "r2", sessionId: "s2" });
    queue.enqueue(req1);
    queue.enqueue(req2);
    expect(queue.count).toBe(2);
    const cleared = queue.clearSession("s1");
    expect(cleared).toBe(1);
    expect(queue.count).toBe(1);
  });

  it("clears all dialogs", () => {
    queue.enqueue(makeRequest());
    queue.enqueue(makeRequest());
    expect(queue.clearAll()).toBe(2);
    expect(queue.count).toBe(0);
  });

  it("notifies notify method fire-and-forget (no dialog)", () => {
    // notify 类型不需要排队，但协议会推送；这里验证不崩
    const req = makeRequest({ method: "notify", message: "hi" });
    queue.enqueue(req);
    // notify 也应作为 pending 显示（简单通知）
    expect(queue.count).toBe(1);
  });
});
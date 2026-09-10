import { describe, expect, it, beforeEach } from "vitest";
import { ExtensionUiQueue, MAX_QUEUED_DIALOGS } from "../src/extension-ui-queue.js";
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
    // notify 类型不需要排队，但协议会推送；验证不入队
    const req = makeRequest({ method: "notify", message: "hi" });
    queue.enqueue(req);
    expect(queue.count).toBe(0);
  });

  it("ignores setStatus/setTitle fire-and-forget requests", () => {
    const status = makeRequest({ method: "setStatus", statusKey: "k", statusText: "v" });
    const title = makeRequest({ method: "setTitle", title: "t" });
    const widget = makeRequest({ method: "setWidget", widgetKey: "w" });
    queue.enqueue(status);
    queue.enqueue(title);
    queue.enqueue(widget);
    expect(queue.count).toBe(0);
  });

  it("only queues interactive methods", () => {
    const select = makeRequest({ method: "select" });
    const input = makeRequest({ method: "input" });
    const confirm = makeRequest({ method: "confirm" });
    const editor = makeRequest({ method: "editor" });
    const notify = makeRequest({ method: "notify" });
    queue.enqueue(select);
    queue.enqueue(input);
    queue.enqueue(confirm);
    queue.enqueue(editor);
    queue.enqueue(notify);
    expect(queue.count).toBe(4);
  });
});

/**
 * ISS-20260910-004：dialogs Map 此前只改 status 从不 delete ⇒ 无界增长。
 * 反向验证：移除 enqueue 中的 pruneFinished() 后，前两条必挂（size 无界）。
 */
describe("ExtensionUiQueue 回收终态条目（ISS-004）", () => {
  const CAP = MAX_QUEUED_DIALOGS;

  function sizeOf(q: ExtensionUiQueue): number {
    return (q as unknown as { dialogs: Map<string, unknown> }).dialogs.size;
  }

  it("持续 answer 后入队：Map 驻留有界（旧实现永久增长）", () => {
    const q = new ExtensionUiQueue();
    for (let i = 0; i < CAP * 3; i++) {
      const req = makeRequest({ id: `r${i}` });
      q.enqueue(req);
      q.answer(req.id, { selected: ["A"] }); // 立即终态： answered
    }
    expect(sizeOf(q), "已作答条目必须被回收，不得累积 192 条").toBeLessThanOrEqual(CAP);
    expect(q.count).toBe(0);
  });

  it("过期条目在后续入队时被回收，但同一批次内仍可被 get 查到（保留现有可见语义）", () => {
    let now = 1000;
    const q = new ExtensionUiQueue({ defaultTimeoutMs: 5000, now: () => now });
    const ids: string[] = [];
    for (let i = 0; i < CAP + 10; i++) {
      const req = makeRequest({ id: `e${i}` });
      q.enqueue(req);
      ids.push(req.id);
    }
    now = 9000; // 全部过期
    expect(q.count).toBe(0);
    expect(q.get(ids[0])?.status).toBe("expired"); // 过期不等于立即消失：仍可查
    // 再入队一条触发修剪：过期条目应被回收
    q.enqueue(makeRequest({ id: "trigger" }));
    expect(sizeOf(q)).toBeLessThanOrEqual(CAP);
  });

  it("全部仍是 pending 时不强制丢弃（用户可见弹窗不得被静默清掉）", () => {
    const q = new ExtensionUiQueue();
    for (let i = 0; i < CAP + 5; i++) q.enqueue(makeRequest({ id: `p${i}` }));
    expect(q.count).toBe(CAP + 5); // 未过期 ⇒ 保留，宁可超限也不丢可见弹窗
    expect(sizeOf(q)).toBe(CAP + 5);
  });

  it("修剪优先回收最早插入的终态条目，pending 条目按插入序保留", () => {
    const q = new ExtensionUiQueue();
    // 先放 CAP 条已作答（终态、插入最早），再放若干 pending
    for (let i = 0; i < CAP; i++) {
      const req = makeRequest({ id: `done${i}` });
      q.enqueue(req);
      q.answer(req.id, { selected: ["A"] });
    }
    q.enqueue(makeRequest({ id: "keep-me" }));
    const pendingIds = q.pendingDialogs.map((d) => d.request.id);
    expect(pendingIds).toContain("keep-me");
    expect(q.get("keep-me")?.status).toBe("pending");
  });

  it("clearSession/clearAll 仍即时清空（回归保护）", () => {
    const q = new ExtensionUiQueue();
    for (let i = 0; i < 5; i++) q.enqueue(makeRequest({ id: `c${i}` }));
    expect(q.clearSession("s1")).toBe(5);
    expect(sizeOf(q)).toBe(0);
    q.enqueue(makeRequest({ id: "x" }));
    expect(q.clearAll()).toBe(1);
    expect(sizeOf(q)).toBe(0);
  });
});

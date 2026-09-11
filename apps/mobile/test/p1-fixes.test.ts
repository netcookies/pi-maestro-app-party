import { describe, expect, it } from "vitest";
import {
  createInitialState,
  reduceEvent,
  createAppActions,
  CONFIRM_TRUE,
  CONFIRM_FALSE,
} from "../src/app-state.js";
import { ExtensionUiQueue } from "../src/extension-ui-queue.js";
import { imageUrlFor } from "../src/image-url.js";
import type { HostEvent, TimelineItem, ExtensionUiRequest } from "@maestro-mobile/shared";

describe("P1-2: confirm 响应按 method 分流", () => {
  function makeQueue(method: ExtensionUiRequest["method"], id = "req-1") {
    const queue = new ExtensionUiQueue();
    queue.enqueue({
      id,
      sessionId: "s1",
      method,
      ...(method === "select" ? { options: ["a", "b"] } : {}),
      ...(method === "editor" ? { prefill: "草稿" } : {}),
    } as ExtensionUiRequest);
    return queue;
  }

  function capture(method: ExtensionUiRequest["method"], value: string | string[], id = "req-1") {
    const queue = makeQueue(method, id);
    const sent: unknown[] = [];
    const actions = createAppActions(queue, (_sid, _rid, response) => sent.push(response));
    actions.answerDialog(id, value);
    return sent[0] as { confirmed?: boolean; value?: string; selected?: string[] } | undefined;
  }

  it("confirm + confirmed:true → { confirmed: true }（而非 { value: \"yes\" }）", () => {
    const response = capture("confirm", CONFIRM_TRUE);
    expect(response).toEqual({ id: "req-1", confirmed: true });
  });

  it("confirm + confirmed:false → { confirmed: false }", () => {
    const response = capture("confirm", CONFIRM_FALSE);
    expect(response).toEqual({ id: "req-1", confirmed: false });
  });

  it("confirm 兼容旧 \"yes\" 语义", () => {
    const response = capture("confirm", "yes");
    expect(response).toEqual({ id: "req-1", confirmed: true });
  });

  it("input 仍发 { value }", () => {
    const response = capture("input", "回答文本");
    expect(response).toEqual({ id: "req-1", value: "回答文本" });
  });

  it("select 仍发 { selected }", () => {
    const response = capture("select", ["a"]);
    expect(response).toEqual({ id: "req-1", selected: ["a"] });
  });
});

describe("P1-1 契约: timeline_item 按 id 去重替换", () => {
  const item = (id: string, text: string): TimelineItem => ({ id, kind: "assistant", text, createdAt: "" });

  it("相同 id 的 timeline_item 替换而非追加", () => {
    let state = createInitialState();
    state = reduceEvent(state, { type: "timeline_item", sessionId: "s1", item: item("live-1", "旧"), seq: 1 } as HostEvent);
    state = reduceEvent(state, { type: "timeline_item", sessionId: "s1", item: item("live-1", "新"), seq: 2 } as HostEvent);
    const timeline = state.timelines.get("s1")!;
    expect(timeline).toHaveLength(1);
    expect(timeline[0].text).toBe("新");
  });

  it("不同 id 正常追加", () => {
    let state = createInitialState();
    state = reduceEvent(state, { type: "timeline_item", sessionId: "s1", item: item("a", "一"), seq: 1 } as HostEvent);
    state = reduceEvent(state, { type: "timeline_item", sessionId: "s1", item: item("b", "二"), seq: 2 } as HostEvent);
    expect(state.timelines.get("s1")).toHaveLength(2);
  });

  it("连续到达相同内容和角色的 user 消息时，复用并替换为最新条目（防乐观回显与 watcher 双重推送）", () => {
    let state = createInitialState();
    const user1: TimelineItem = { id: "user-1", kind: "user", text: "测试消息", createdAt: "1" };
    const user2: TimelineItem = { id: "tail-custom-2", kind: "user", text: "测试消息", createdAt: "2" };
    state = reduceEvent(state, { type: "timeline_item", sessionId: "s1", item: user1, seq: 1 } as HostEvent);
    state = reduceEvent(state, { type: "timeline_item", sessionId: "s1", item: user2, seq: 2 } as HostEvent);
    const timeline = state.timelines.get("s1")!;
    expect(timeline).toHaveLength(1);
    expect(timeline[0].id).toBe("tail-custom-2");
  });

  it("timeline_delta 对未知 id 忽略（终态由 timeline_item 补齐）", () => {
    const state = reduceEvent(createInitialState(), {
      type: "timeline_delta", sessionId: "s1", itemId: "ghost", delta: "x", seq: 1,
    } as HostEvent);
    expect(state.timelines.get("s1")).toBeUndefined();
  });
});

describe("P1-5: imageUrlFor 携带 token", () => {
  it("无 token 时 URL 不变", () => {
    expect(imageUrlFor("ws://192.168.1.5:4739/ws", "/tmp/a.png")).toBe(
      "http://192.168.1.5:4739/api/file?path=" + encodeURIComponent("/tmp/a.png"),
    );
  });

  it("有 token 时追加 &token=", () => {
    const url = imageUrlFor("ws://192.168.1.5:4739/ws", "/tmp/a.png", "secret-token");
    expect(url).toContain("token=secret-token");
    expect(url.startsWith("http://192.168.1.5:4739/api/file?path=")).toBe(true);
  });

  it("token 特殊字符被编码", () => {
    const url = imageUrlFor("ws://h:1/ws", "/a.png", "a&b=c");
    expect(url).toContain(encodeURIComponent("a&b=c"));
  });

  it("空 hostUrl/path 仍返回空串", () => {
    expect(imageUrlFor("", "/a.png", "t")).toBe("");
    expect(imageUrlFor("ws://h:1/ws", "", "t")).toBe("");
  });
});

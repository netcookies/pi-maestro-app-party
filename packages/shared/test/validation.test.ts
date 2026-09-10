import { describe, expect, it } from "vitest";
import { validateHostEvent, validateClientCommand, validateJsonSerializable } from "../src/validation.js";

describe("validation", () => {
  it("accepts well-formed events and commands", () => {
    expect(() => validateHostEvent({ type: "host_status", status: "idle", seq: 1 })).not.toThrow();
    expect(() => validateClientCommand({ type: "abort", sessionId: "s1" })).not.toThrow();
  });

  it("rejects malformed inputs", () => {
    expect(() => validateHostEvent({ type: "host_status", status: "idle" })).toThrow();
    expect(() => validateClientCommand(null)).toThrow();
  });

  it("checks JSON serializability", () => {
    expect(() => validateJsonSerializable({ a: 1, b: [2, 3] })).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateJsonSerializable(circular)).toThrow();
  });
});

/**
 * ISS-20260910-003：validateClientCommand 收紧 id 类型（只加「若存在则必须 string」）。
 * 反向验证：删掉 validation.ts 里的 id 分支后，本 describe 三条必挂。
 */
describe("validateClientCommand 的 id 类型校验（ISS-003）", () => {
  it("字符串 id 合法（现有客户端形态：cmd-N）", () => {
    expect(() => validateClientCommand({ type: "abort", sessionId: "s1", id: "cmd-7" })).not.toThrow();
  });

  it("无 id 仍合法（向后兼容：id 不在 ClientCommand 类型联合中）", () => {
    expect(() => validateClientCommand({ type: "abort", sessionId: "s1" })).not.toThrow();
    expect(() => validateClientCommand({ type: "abort", sessionId: "s1", id: undefined })).not.toThrow();
  });

  it("数值 id 被拒且文案指明是 id 问题（服务端据此回 invalid_command，不再挂 30s）", () => {
    // 旧行为：数值 id 被服务端盲目回显 → 客户端 in_reply_to 归一为 "" → 匹配不到 → 挂 30s
    let err: Error | undefined;
    try {
      validateClientCommand({ type: "abort", sessionId: "s1", id: 42 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("id must be a string");
    expect(err!.message).not.toContain("missing type");
  });

  it("其它非字符串 id（null/对象/布尔）一律被拒", () => {
    for (const bad of [null, {}, true, ["x"]]) {
      expect(() => validateClientCommand({ type: "abort", sessionId: "s1", id: bad })).toThrow(/id must be a string/);
    }
  });

  it("缺 type 的拒因仍是 missing type（不与 id 校验混淆）", () => {
    expect(() => validateClientCommand({ sessionId: "s1", id: 42 })).toThrow(/missing type/);
  });
});

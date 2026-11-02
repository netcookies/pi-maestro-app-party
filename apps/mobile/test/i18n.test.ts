import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "../src/i18n";

describe("I18n", () => {
  it("dictionaries provide symmetric keys", () => {
    const zhKeys = Object.keys(DICTIONARIES.zh).sort();
    const enKeys = Object.keys(DICTIONARIES.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("provides expected translations", () => {
    expect(DICTIONARIES.zh.tabSessions).toBe("会话");
    expect(DICTIONARIES.en.tabSessions).toBe("Sessions");
    expect(DICTIONARIES.zh.filterCurrent).toBe("当前会话");
    expect(DICTIONARIES.en.filterCurrent).toBe("Current");
    expect(DICTIONARIES.zh.hostConnected).toBe("已连接主机");
    expect(DICTIONARIES.en.hostConnected).toBe("Connected");
    expect(DICTIONARIES.zh.tool).toBe("工具");
    expect(DICTIONARIES.en.tool).toBe("Tool");
    expect(DICTIONARIES.zh.error).toBe("错误");
    expect(DICTIONARIES.en.error).toBe("Error");
    expect(DICTIONARIES.zh.toolCalls(3)).toBe("工具调用 3 次");
    expect(DICTIONARIES.en.toolCalls(3)).toBe("3 Tool Calls");
    expect(DICTIONARIES.en.toolCalls(1)).toBe("1 Tool Call");
  });
});

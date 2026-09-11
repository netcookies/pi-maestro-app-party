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
    expect(DICTIONARIES.zh.filterActive).toBe("活跃中");
    expect(DICTIONARIES.en.filterActive).toBe("Active");
    expect(DICTIONARIES.zh.hostConnected).toBe("已连接主机");
    expect(DICTIONARIES.en.hostConnected).toBe("Connected");
  });
});

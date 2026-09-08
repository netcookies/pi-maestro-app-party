import { describe, expect, it, beforeEach } from "vitest";

// 内存版 AsyncStorage mock（模块级单例）
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
  },
}));
import { afterEach, vi } from "vitest";
import {
  loadPairedHosts, savePairedHosts, importLegacyConnection,
  rememberRemovedHost, forgetRemovedHost, loadRemovedHosts,
} from "../src/paired-hosts.js";

describe("paired-hosts 幽灵修复", () => {
  beforeEach(() => { store.clear(); });
  afterEach(() => { store.clear(); });

  it("删除记忆：removed 后 legacy 不再导入；重新配对解除记忆", async () => {
    // 初始：legacy 键有 127.0.0.1
    store.set("maestro-mobile.host-connection", JSON.stringify({ hostUrl: "ws://127.0.0.1:4739/ws", token: "t" }));
    // 首次导入成功
    let list = await importLegacyConnection();
    expect(list.some((h) => h.hostUrl === "ws://127.0.0.1:4739/ws")).toBe(true);
    // 用户删除该 host → 记住删除
    await rememberRemovedHost("ws://127.0.0.1:4739/ws");
    // 模拟用户同时清掉了 paired 列表（删除动作本身）
    await savePairedHosts([]);
    // 幽灵场景：legacy 键仍有旧值，再导入 → 不应回来
    list = await importLegacyConnection();
    expect(list.some((h) => h.hostUrl === "ws://127.0.0.1:4739/ws")).toBe(false);
    expect(await loadPairedHosts()).toHaveLength(0);
    // 重新配对成功 → 解除记忆 → 又能导入
    await forgetRemovedHost("ws://127.0.0.1:4739/ws");
    list = await importLegacyConnection();
    expect(list.some((h) => h.hostUrl === "ws://127.0.0.1:4739/ws")).toBe(true);
  });

  it("未删除的 host 正常导入（回归保护）", async () => {
    store.set("maestro-mobile.host-connection", JSON.stringify({ hostUrl: "ws://192.168.1.5:4739/ws", token: "t" }));
    const list = await importLegacyConnection();
    expect(list).toHaveLength(1);
    expect(list[0].hostUrl).toBe("ws://192.168.1.5:4739/ws");
  });
});

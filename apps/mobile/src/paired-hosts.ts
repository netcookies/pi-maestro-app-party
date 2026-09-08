/**
 * paired-hosts — 已配对 Host 列表持久化（AsyncStorage）
 *
 * 多 Host 实例支持：扫码配对成功的 host 存列表（最多 8 台），卡片内切换。
 * 结构刻意扁平：name 为展示名（扫码时取 ws 主机名），hostUrl/token 为连接参数。
 */

export interface PairedHost {
  /** 展示名（默认取 ws 地址 host:port；未来可由 host 上报自定义名） */
  name: string;
  /** WebSocket 地址（含 /ws 路径） */
  hostUrl: string;
  /** 鉴权 token（空 = host 未启用鉴权） */
  token: string;
  /** 配对时间（ISO） */
  pairedAt: string;
}

const KEY = "maestro-mobile.paired-hosts";

export async function loadPairedHosts(): Promise<PairedHost[]> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as PairedHost[];
    return Array.isArray(list) ? list.filter((h) => h && typeof h.hostUrl === "string") : [];
  } catch {
    return [];
  }
}

export async function savePairedHosts(list: PairedHost[]): Promise<void> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    await AsyncStorage.setItem(KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    // 存储失败静默（下次配对重建）
  }
}

const REMOVED_KEY = "maestro-mobile.removed-hosts";

/** 已删除 host 的永久记忆：防止 importLegacyConnection 把用户删掉的地址重新导入（幽灵 127.0.0.1） */
export async function loadRemovedHosts(): Promise<string[]> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const raw = await AsyncStorage.getItem(REMOVED_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 删除配对时记录 hostUrl（用户主动删除的地址不再自动导入；重新配对成功时移除记录） */
export async function rememberRemovedHost(hostUrl: string): Promise<void> {
  try {
    const removed = await loadRemovedHosts();
    if (!removed.includes(hostUrl)) {
      const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
      await AsyncStorage.setItem(REMOVED_KEY, JSON.stringify([...removed, hostUrl].slice(-32)));
    }
  } catch { /* 静默 */ }
}

export async function forgetRemovedHost(hostUrl: string): Promise<void> {
  try {
    const removed = await loadRemovedHosts();
    if (removed.includes(hostUrl)) {
      const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
      await AsyncStorage.setItem(REMOVED_KEY, JSON.stringify(removed.filter((h) => h !== hostUrl)));
    }
  } catch { /* 静默 */ }
}

/** 兼容迁移：旧版单 host 连接参数（maestro-mobile.host-connection）导入为第一条配对记录 */
export async function importLegacyConnection(): Promise<PairedHost[]> {
  try {
    const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
    const raw = await AsyncStorage.getItem("maestro-mobile.host-connection");
    if (!raw) return [];
    const saved = JSON.parse(raw) as { hostUrl?: string; token?: string };
    if (!saved.hostUrl || !/^wss?:\/\//.test(saved.hostUrl)) return [];
    // 幽灵修复：用户主动删除过的地址不再重新导入
    const removed = await loadRemovedHosts();
    if (removed.includes(saved.hostUrl)) return loadPairedHosts();
    const existing = await loadPairedHosts();
    if (existing.some((h) => h.hostUrl === saved.hostUrl)) return existing;
    const imported: PairedHost = {
      name: legacyName(saved.hostUrl),
      hostUrl: saved.hostUrl,
      token: saved.token ?? "",
      pairedAt: new Date().toISOString(),
    };
    const next = [imported, ...existing];
    await savePairedHosts(next);
    return next;
  } catch {
    return [];
  }
}

function legacyName(hostUrl: string): string {
  try {
    const u = new URL(hostUrl);
    return `${u.hostname}:${u.port || "80"}`;
  } catch {
    return hostUrl;
  }
}

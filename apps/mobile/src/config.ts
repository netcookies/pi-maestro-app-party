/**
 * 应用可配置参数（替代写死常量）
 *
 * 用户可在设置页调整，持久化到 AsyncStorage。
 * 默认值在 DEFAULT_CONFIG；setConfig 更新全局。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface AppConfig {
  /** 历史懒加载每页消息数 */
  historyPageSize: number;
  /** 顶部自动加载触发阈值 px */
  loadMoreThreshold: number;
  /** 懒加载冷却 ms（防连环触发） */
  loadCooldownMs: number;
  /** 底部跟随判定距离 px */
  stickBottomTolerance: number;
  /** 会话列表轮询活跃状态间隔 ms */
  livePollIntervalMs: number;
  /** 搜索最大结果数 */
  searchMaxResults: number;
  /** 消息预览截断长度 */
  previewLength: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  historyPageSize: 80,
  loadMoreThreshold: 40,
  loadCooldownMs: 800,
  stickBottomTolerance: 80,
  livePollIntervalMs: 5000,
  searchMaxResults: 30,
  previewLength: 80,
};

const CONFIG_STORAGE_KEY = "maestro-mobile.config";

let currentConfig: AppConfig = { ...DEFAULT_CONFIG };

export function getConfig(): AppConfig {
  return currentConfig;
}

/** 更新单值配置（合并 + 持久化） */
export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  currentConfig = { ...currentConfig, ...patch };
  await AsyncStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(currentConfig)).catch(() => {});
  return currentConfig;
}

/** 启动时加载持久化配置 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await AsyncStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      currentConfig = { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // 默认配置
  }
  return currentConfig;
}
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

/** 各字段合法范围（有限正整数约束；clamp 防 0/负/小数/NaN） */
const CONFIG_LIMITS: Record<keyof AppConfig, { min: number; max: number }> = {
  historyPageSize: { min: 5, max: 500 },
  loadMoreThreshold: { min: 4, max: 500 },
  loadCooldownMs: { min: 100, max: 10000 },
  stickBottomTolerance: { min: 8, max: 500 },
  livePollIntervalMs: { min: 1000, max: 120000 },
  searchMaxResults: { min: 1, max: 200 },
  previewLength: { min: 10, max: 1000 },
};

const APPEARANCE_STORAGE_KEY = "maestro-mobile.appearance";

export type AppearanceChoice = "auto" | "light" | "dark";

let appearanceChoice: AppearanceChoice = "auto";

/** 当前外观段选择（P3-6：auto 与 light 共用 miuix-light 皮肤时，选中态靠它区分） */
export function getAppearanceChoice(): AppearanceChoice {
  return appearanceChoice;
}

export async function setAppearanceChoice(choice: AppearanceChoice): Promise<void> {
  appearanceChoice = choice;
  await AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, choice).catch(() => {});
}

/** 启动时恢复外观选择（与 loadConfig 同期调用） */
export async function loadAppearanceChoice(): Promise<AppearanceChoice> {
  try {
    const raw = await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === "auto" || raw === "light" || raw === "dark") {
      appearanceChoice = raw;
    }
  } catch {
    // 默认 auto
  }
  return appearanceChoice;
}

/** 清洗非法配置：非有限数/越界回退默认 */
function sanitizeConfig(patch: Partial<AppConfig>): Partial<AppConfig> {
  const clean: Partial<AppConfig> = {};
  for (const key of Object.keys(CONFIG_LIMITS) as (keyof AppConfig)[]) {
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const { min, max } = CONFIG_LIMITS[key];
    clean[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  return clean;
}

let currentConfig: AppConfig = { ...DEFAULT_CONFIG };

export function getConfig(): AppConfig {
  return currentConfig;
}

/** 更新单值配置（清洗 + 合并 + 持久化） */
export async function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const clean = sanitizeConfig(patch);
  currentConfig = { ...currentConfig, ...clean };
  await AsyncStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(currentConfig)).catch(() => {});
  return currentConfig;
}

/** 启动时加载持久化配置（清洗非法存储值） */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await AsyncStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const clean = sanitizeConfig(parsed);
      currentConfig = { ...DEFAULT_CONFIG, ...clean };
    }
  } catch {
    // 默认配置
  }
  return currentConfig;
}
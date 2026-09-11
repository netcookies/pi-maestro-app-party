/**
 * 主题系统 — 参考 pi-cockpit 的颜色语义设计
 *
 * pi-cockpit 主题 = vars(调色板) + colors(语义映射) + export(页面背景)
 * 这里提炼为 App 可用的语义色板，围绕"消息/工具/markdown/界面"四组语义。
 */
import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface AppTheme {
  /** 主题名 */
  name: string;
  /** 界面 */
  bg: string;
  cardBg: string;
  border: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  /** Miuix slider 语义 */
  sliderBackground?: string;
  sliderKeyPoint?: string;
  /** 消息 */
  userBubble: string;
  userText: string;
  agentBubble: string;
  toolBubble: string;
  toolTitle: string;
  toolOutput: string;
  /** 状态 */
  success: string;
  error: string;
  warning: string;
  info: string;
  /** 输入框 */
  inputBg: string;
  buttonPrimary: string;
  buttonDanger: string;
  /** Markdown */
  mdHeading: string;
  mdLink: string;
  mdCode: string;
  mdCodeBlock: string;
  mdCodeBlockBg: string;
  mdQuote: string;
  mdQuoteBorder: string;
  mdHr: string;
  /** 导航 */
  headerBg: string;
  headerText: string;
  /** 卡片内部嵌套块背景 */
  cardInner?: string;
  /** Miuix 语义扩展槽（全部可选，旧主题可不提供） */
  surfaceVariant?: string;
  onSurfaceVariantSummary?: string;
  tertiaryContainer?: string;
  onTertiaryContainer?: string;
  secondaryContainer?: string;
  onSecondaryContainer?: string;
  disabledPrimaryButton?: string;
  outline?: string;
  dividerLine?: string;
  onBackgroundVariant?: string;
  windowDimming?: string;
}

export const ACCENT_PALETTES = [
  { id: "violet", name: "工坊紫", color: "#8B5CF6" },
  { id: "cobalt", name: "深海蓝", color: "#2563EB" },
  { id: "emerald", name: "赛博绿", color: "#10B981" },
  { id: "amber", name: "落日橙", color: "#F59E0B" },
  { id: "rose", name: "霓虹粉", color: "#F43F5E" },
] as const;

export const THEMES: Record<string, AppTheme> = {
  // ── Miuix Light（方案 B 便当盒轻量浅色规范）──
  "miuix-light": {
    name: "Miuix Light",
    bg: "#F4F5F7", cardBg: "#FFFFFF", cardInner: "#F8F9FA", border: "#E5E7EB",
    text: "#0F172A", muted: "#64748B", dim: "#94A3B8", accent: "#8B5CF6",
    userBubble: "#8B5CF6", userText: "#FFFFFF",
    agentBubble: "#FFFFFF", toolBubble: "#F8F9FA",
    toolTitle: "#0F172A", toolOutput: "rgba(15,23,42,0.85)",
    success: "#10B981", error: "#EF4444", warning: "#F59E0B", info: "#3B82F6",
    inputBg: "#F1F5F9", buttonPrimary: "#8B5CF6", buttonDanger: "#EF4444",
    mdHeading: "#0F172A", mdLink: "#8B5CF6", mdCode: "#7C3AED",
    mdCodeBlock: "#0F172A", mdCodeBlockBg: "#F8F9FA", mdQuote: "#64748B", mdQuoteBorder: "#E2E8F0", mdHr: "#E2E8F0",
    headerBg: "#FFFFFF", headerText: "#0F172A",
    surfaceVariant: "#F8F9FA", onSurfaceVariantSummary: "#64748B",
    tertiaryContainer: "#F3E8FF", onTertiaryContainer: "#7C3AED",
    secondaryContainer: "#F1F5F9", onSecondaryContainer: "#64748B",
    disabledPrimaryButton: "#DDD6FE", outline: "#E2E8F0", dividerLine: "#E2E8F0",
    onBackgroundVariant: "#64748B", windowDimming: "rgba(0,0,0,0.3)",
    sliderBackground: "rgba(0,0,0,0.06)", sliderKeyPoint: "rgba(0,0,0,0.25)",
  },

  // ── Miuix Dark（方案 B 便当盒深邃极黑 OLED 原型真实规范）──
  "miuix-dark": {
    name: "Miuix Dark",
    bg: "#08090C", cardBg: "#12151B", cardInner: "#181C24", border: "#202530",
    text: "#E6EDF3", muted: "#8B949E", dim: "#6B7280", accent: "#8B5CF6",
    userBubble: "#8B5CF6", userText: "#FFFFFF",
    agentBubble: "#12151B", toolBubble: "#181C24",
    toolTitle: "#F3F4F6", toolOutput: "rgba(243,244,246,0.85)",
    success: "#10B981", error: "#EF4444", warning: "#F59E0B", info: "#3B82F6",
    inputBg: "#181C24", buttonPrimary: "#8B5CF6", buttonDanger: "#EF4444",
    mdHeading: "#F3F4F6", mdLink: "#A78BFA", mdCode: "#C4B5FD",
    mdCodeBlock: "#F3F4F6", mdCodeBlockBg: "#181C24", mdQuote: "#8B949E", mdQuoteBorder: "#202530", mdHr: "#202530",
    headerBg: "#12151B", headerText: "#E6EDF3",
    surfaceVariant: "#181C24", onSurfaceVariantSummary: "#8B949E",
    tertiaryContainer: "#2E1A47", onTertiaryContainer: "#A78BFA",
    secondaryContainer: "#181C24", onSecondaryContainer: "#8B949E",
    disabledPrimaryButton: "#4C1D95", outline: "#202530", dividerLine: "#202530",
    onBackgroundVariant: "#6B7280", windowDimming: "rgba(0,0,0,0.6)",
    sliderBackground: "rgba(255,255,255,0.15)", sliderKeyPoint: "rgba(255,255,255,0.3)",
  },

  // ── 深色 базов (原 App 配色) ──
  dark: {
    name: "Dark",
    bg: "#0d1117", cardBg: "#161b22", border: "#21262d",
    text: "#e6edf3", muted: "#8b949e", dim: "#484f58", accent: "#58a6ff",
    userBubble: "#1f6feb", userText: "#ffffff",
    agentBubble: "#161b22", toolBubble: "#0d1117",
    toolTitle: "#c9d1d9", toolOutput: "#c9d1d9",
    success: "#3fb950", error: "#f85149", warning: "#d29922", info: "#58a6ff",
    inputBg: "#0d1117", buttonPrimary: "#238636", buttonDanger: "#da3633",
    mdHeading: "#e6edf3", mdLink: "#58a6ff", mdCode: "#79c0ff",
    mdCodeBlock: "#c9d1d9", mdCodeBlockBg: "#0d1117", mdQuote: "#8b949e", mdQuoteBorder: "#30363d", mdHr: "#21262d",
    headerBg: "#161b22", headerText: "#e6edf3",
  },

  // ── Ocean（cockpit-ocean 配色）──
  ocean: {
    name: "Ocean",
    bg: "#161923", cardBg: "#1d2233", border: "#3b4261",
    text: "#c8d3f5", muted: "#828bb8", dim: "#565f89", accent: "#7dcfff",
    userBubble: "#2b3150", userText: "#c0caf5",
    agentBubble: "#1d2233", toolBubble: "#202940",
    toolTitle: "#c0caf5", toolOutput: "#828bb8",
    success: "#9ece6a", error: "#f7768e", warning: "#ff9e64", info: "#7aa2f7",
    inputBg: "#1d2233", buttonPrimary: "#22352f", buttonDanger: "#3b2732",
    mdHeading: "#c0caf5", mdLink: "#7aa2f7", mdCode: "#7dcfff",
    mdCodeBlock: "#c8d3f5", mdCodeBlockBg: "#202940", mdQuote: "#828bb8", mdQuoteBorder: "#3b4261", mdHr: "#3b4261",
    headerBg: "#1d2233", headerText: "#c8d3f5",
  },

  // ── Notion（cockpit-notion 思路：浅色）──
  notion: {
    name: "Notion",
    bg: "#f7f7f5", cardBg: "#ffffff", border: "#e9e9e7",
    text: "#37352f", muted: "#787774", dim: "#c0bebb", accent: "#3b82f6",
    userBubble: "#2383e2", userText: "#ffffff",
    agentBubble: "#ffffff", toolBubble: "#f7f7f5",
    toolTitle: "#37352f", toolOutput: "#57534e",
    success: "#2e9e5b", error: "#e5484d", warning: "#f59e0b", info: "#3b82f6",
    inputBg: "#f7f7f5", buttonPrimary: "#2383e2", buttonDanger: "#e5484d",
    mdHeading: "#37352f", mdLink: "#3b82f6", mdCode: "#eb5757",
    mdCodeBlock: "#37352f", mdCodeBlockBg: "#f1f1ef", mdQuote: "#787774", mdQuoteBorder: "#e9e9e7", mdHr: "#e9e9e7",
    headerBg: "#ffffff", headerText: "#37352f",
  },

  // ── Zen（cockpit-zen 思路：低饱和）──
  zen: {
    name: "Zen",
    bg: "#1a1b1e", cardBg: "#222326", border: "#2f3035",
    text: "#d4d4d8", muted: "#8b8d98", dim: "#52525b", accent: "#a78bfa",
    userBubble: "#4c1d95", userText: "#f5f3ff",
    agentBubble: "#222326", toolBubble: "#1a1b1e",
    toolTitle: "#a78bfa", toolOutput: "#a1a1aa",
    success: "#34d399", error: "#f87171", warning: "#fbbf24", info: "#818cf8",
    inputBg: "#222326", buttonPrimary: "#4c1d95", buttonDanger: "#9f1239",
    mdHeading: "#f5f3ff", mdLink: "#a78bfa", mdCode: "#f0abfc",
    mdCodeBlock: "#d4d4d8", mdCodeBlockBg: "#1a1b1e", mdQuote: "#8b8d98", mdQuoteBorder: "#3f3f46", mdHr: "#3f3f46",
    headerBg: "#222326", headerText: "#d4d4d8",
  },
};

export const MIUIX_RADIUS = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };
export const MIUIX_TYPE = { footnote2: 11, footnote1: 13, body2: 14, body1: 16, main: 17, title4: 18, title3: 20, title2: 24, title1: 32 };
export const MIUIX_SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 };

export const DEFAULT_THEME = "miuix-light";

export interface ThemeContextValue {
  theme: AppTheme;
  themeName: string;
  setTheme: (name: string) => void;
  themeNames: string[];
  customAccent: string;
  setCustomAccent: (color: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_STORAGE_KEY = "maestro-mobile.theme";
const APPEARANCE_CHOICE_KEY = "maestro-mobile.appearance";
const ACCENT_COLOR_STORAGE_KEY = "maestro-mobile.accent-color";

export type AppearanceChoice = "auto" | "light" | "dark";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [choice, setChoice] = useState<AppearanceChoice>("auto");
  const [themeName, setThemeName] = useState<string>(DEFAULT_THEME);
  const [customAccent, setCustomAccentState] = useState<string>(ACCENT_PALETTES[0].color);

  // 启动时读持久化选择、主题与高光色
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      AsyncStorage.getItem(APPEARANCE_CHOICE_KEY),
      AsyncStorage.getItem(THEME_STORAGE_KEY),
      AsyncStorage.getItem(ACCENT_COLOR_STORAGE_KEY),
    ]).then(([savedChoice, savedTheme, savedAccent]) => {
      if (cancelled) return;
      if (savedChoice === "auto" || savedChoice === "light" || savedChoice === "dark") {
        setChoice(savedChoice);
      }
      if (savedTheme && THEMES[savedTheme]) {
        setThemeName(savedTheme);
      }
      if (savedAccent) {
        setCustomAccentState(savedAccent);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 响应系统深色/浅色变化或用户选择
  useEffect(() => {
    if (choice === "auto") {
      setThemeName(systemScheme === "dark" ? "miuix-dark" : "miuix-light");
    } else if (choice === "dark") {
      setThemeName("miuix-dark");
    } else {
      setThemeName("miuix-light");
    }
  }, [choice, systemScheme]);

  const setTheme = useCallback((name: string) => {
    if (!THEMES[name]) return;
    setThemeName(name);
    void AsyncStorage.setItem(THEME_STORAGE_KEY, name).catch(() => {});
  }, []);

  const setCustomAccent = useCallback((color: string) => {
    setCustomAccentState(color);
    void AsyncStorage.setItem(ACCENT_COLOR_STORAGE_KEY, color).catch(() => {});
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const baseTheme = THEMES[themeName] ?? THEMES[DEFAULT_THEME];
    // 动态融合自定义高光品牌色
    const mergedTheme: AppTheme = {
      ...baseTheme,
      accent: customAccent,
      buttonPrimary: customAccent,
      userBubble: customAccent,
      mdLink: customAccent,
      mdCode: customAccent,
    };
    return {
      theme: mergedTheme,
      themeName,
      setTheme,
      themeNames: Object.keys(THEMES),
      customAccent,
      setCustomAccent,
    };
  }, [themeName, setTheme, customAccent, setCustomAccent]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}

/** 将 hex 颜色转为带有指定透明度的 rgba 字符串，用于动态计算高光微光背景与微光边框 */
export function hexToRgba(hex: string, alpha: number): string {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) {
    return `rgba(139, 92, 246, ${alpha})`;
  }
  const clean = hex.slice(1);
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(139, 92, 246, ${alpha})`;
}
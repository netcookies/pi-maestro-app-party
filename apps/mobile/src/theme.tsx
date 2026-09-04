/**
 * 主题系统 — 参考 pi-cockpit 的颜色语义设计
 *
 * pi-cockpit 主题 = vars(调色板) + colors(语义映射) + export(页面背景)
 * 这里提炼为 App 可用的语义色板，围绕"消息/工具/markdown/界面"四组语义。
 */
import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from "react";
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

export const THEMES: Record<string, AppTheme> = {
  // ── Miuix Light（design-spec §6 Light 列真实值）──
  "miuix-light": {
    name: "Miuix Light",
    bg: "#FFFFFF", cardBg: "#F7F7F7", border: "#D9D9D9",
    text: "#000000", muted: "#666666", dim: "rgba(0,0,0,0.6)", accent: "#3482FF",
    userBubble: "#3482FF", userText: "#FFFFFF",
    agentBubble: "#FFFFFF", toolBubble: "#F7F7F7",
    toolTitle: "#000000", toolOutput: "rgba(0,0,0,0.8)",
    success: "#1E8E4E", error: "#E94634", warning: "#B25E09", info: "#3482FF",
    inputBg: "#F7F7F7", buttonPrimary: "#3482FF", buttonDanger: "#E94634",
    mdHeading: "#000000", mdLink: "#3482FF", mdCode: "#B34700",
    mdCodeBlock: "#000000", mdCodeBlockBg: "#F7F7F7", mdQuote: "#666666", mdQuoteBorder: "#E0E0E0", mdHr: "#E0E0E0",
    headerBg: "#FFFFFF", headerText: "#000000",
    surfaceVariant: "#F7F7F7", onSurfaceVariantSummary: "rgba(0,0,0,0.6)",
    tertiaryContainer: "#EAF2FF", onTertiaryContainer: "#3482FF",
    secondaryContainer: "#F0F0F0", onSecondaryContainer: "#A9A9A9",
    disabledPrimaryButton: "#C2D9FF", outline: "#D9D9D9", dividerLine: "#E0E0E0",
    onBackgroundVariant: "#8C93B0", windowDimming: "rgba(0,0,0,0.3)",
  },

  // ── Miuix Dark（design-spec §6 Dark 列真实值；卡片取 surfaceContainerHighest #2D2D2D）──
  "miuix-dark": {
    name: "Miuix Dark",
    bg: "#242424", cardBg: "#2D2D2D", border: "#404040",
    text: "rgba(255,255,255,0.9)", muted: "#A8A8A8", dim: "#999999", accent: "#277AF7",
    userBubble: "#277AF7", userText: "#FFFFFF",
    agentBubble: "#2D2D2D", toolBubble: "#242424",
    toolTitle: "#F2F2F2", toolOutput: "rgba(255,255,255,0.8)",
    success: "#4ADE80", error: "#F12522", warning: "#FBBF24", info: "#277AF7",
    inputBg: "#242424", buttonPrimary: "#277AF7", buttonDanger: "#F12522",
    mdHeading: "rgba(255,255,255,0.9)", mdLink: "#277AF7", mdCode: "#99C7F1",
    mdCodeBlock: "#F2F2F2", mdCodeBlockBg: "#242424", mdQuote: "#A8A8A8", mdQuoteBorder: "#393939", mdHr: "#393939",
    headerBg: "#242424", headerText: "rgba(255,255,255,0.9)",
    surfaceVariant: "#2D2D2D", onSurfaceVariantSummary: "#999999",
    tertiaryContainer: "#2B3B54", onTertiaryContainer: "#4788FF",
    secondaryContainer: "#434343", onSecondaryContainer: "#7C7C7C",
    disabledPrimaryButton: "#253E64", outline: "#404040", dividerLine: "#393939",
    onBackgroundVariant: "#787E96", windowDimming: "rgba(0,0,0,0.6)",
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

interface ThemeContextValue {
  theme: AppTheme;
  themeName: string;
  setTheme: (name: string) => void;
  themeNames: string[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_STORAGE_KEY = "maestro-mobile.theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeName] = useState<string>(DEFAULT_THEME);

  // 启动时读持久化主题
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(THEME_STORAGE_KEY).then((saved) => {
      if (!cancelled && saved && THEMES[saved]) setThemeName(saved);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const setTheme = useCallback((name: string) => {
    if (!THEMES[name]) return;
    setThemeName(name);
    void AsyncStorage.setItem(THEME_STORAGE_KEY, name).catch(() => {});
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme: THEMES[themeName] ?? THEMES[DEFAULT_THEME],
    themeName,
    setTheme,
    themeNames: Object.keys(THEMES),
  }), [themeName, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput } from "react-native";
import { useHost } from "../src/store";
import { useTheme, THEMES, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import { DEFAULT_CONFIG, getConfig, updateConfig, loadConfig, type AppConfig } from "../src/config";
import { MiuixSwitch } from "../src/components/MiuixSwitch";
import { MiuixSlider } from "../src/components/MiuixSlider";
import { LineIcon } from "../src/components/LineIcon";

const configFields: { key: keyof AppConfig; label: string; unit: string; max: number }[] = [
  { key: "historyPageSize", label: "每页消息数", unit: "条", max: 200 },
  { key: "loadMoreThreshold", label: "自动加载阈值", unit: "px", max: 500 },
  { key: "livePollIntervalMs", label: "活跃轮询间隔", unit: "ms", max: 10000 },
  { key: "previewLength", label: "消息预览长度", unit: "字符", max: 300 },
];

/** 外观三段（设计稿 SegmentedControl）：跟随系统 / 浅色 / 深色。
 *  P3-6：themeKey 与主题名分离 —— auto 与 light 都映射 miuix-light 皮肤，但选中态可区分。 */
const APPEARANCE_SEGMENTS = [
  { key: "auto", label: "跟随系统", themeKey: "auto", themeName: "miuix-light" },
  { key: "light", label: "浅色", themeKey: "light", themeName: "miuix-light" },
  { key: "dark", label: "深色", themeKey: "dark", themeName: "miuix-dark" },
];

/** 由当前主题名 + 持久化的选择推断当前段：浅色皮肤时按用户上次选择（auto/light），深色固定 dark */
function useAppearanceSegment(): number {
  const { themeName } = useTheme();
  const [storedChoice, setStoredChoice] = useState<"auto" | "light">("auto");
  useEffect(() => {
    void import("../src/config").then(({ getAppearanceChoice }) => {
      setStoredChoice(getAppearanceChoice());
    });
  }, []);
  return themeName === "miuix-dark" ? 2 : storedChoice === "light" ? 1 : 0;
}

const maestroSettingsKeys = ["defaultModel", "defaultProvider", "defaultThinkingLevel", "theme", "hideThinkingBlock"];

export default function SettingsScreen() {
  const { connectionState, isConnected, state, getMaestroSettings, updateMaestroSettings } = useHost();
  const { theme, themeName, setTheme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [config, setConfig] = useState<AppConfig>(getConfig());
  const [configDraft, setConfigDraft] = useState<Partial<AppConfig>>({});
  const [maestroSettings, setMaestroSettings] = useState<Record<string, unknown> | null>(null);
  const [maestroDraft, setMaestroDraft] = useState<Record<string, string>>({});
  // 本地行为偏好（演示态，不接 Host）
  const [notifAttention, setNotifAttention] = useState(true);
  const [askHaptic, setAskHaptic] = useState(true);
  const [wifiOnly, setWifiOnly] = useState(false);

  useEffect(() => {
    void loadConfig().then((c) => setConfig(c));
  }, []);

  const loadMaestro = async () => {
    try {
      const overview = await getMaestroSettings();
      const settingsFile = overview.files.find((f) => f.key === "settings");
      if (settingsFile) setMaestroSettings(settingsFile.data);
    } catch {
      // 加载失败静默
    }
  };

  const saveMaestroSettings = async () => {
    const patch = Object.fromEntries(
      Object.entries(maestroDraft).filter(([, v]) => v !== undefined && v !== ""),
    );
    const r = await updateMaestroSettings(patch);
    if (r.ok) {
      setMaestroDraft({});
      await loadMaestro();
    }
  };

  const saveConfig = async () => {
    const next = await updateConfig(configDraft);
    setConfig(next);
    setConfigDraft({});
  };

  const currentSeg = useAppearanceSegment();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* 外观：SegmentedControl 三段（设计稿 seg-wrap） */}
      <Text style={styles.smallTitle}>外观</Text>
      <View style={[styles.segWrap, { backgroundColor: theme.secondaryContainer ?? theme.cardBg }]}>
        {APPEARANCE_SEGMENTS.map((seg, i) => {
          const active = i === currentSeg;
          return (
            <TouchableOpacity
              key={seg.key}
              style={[styles.segItem, active && { backgroundColor: theme.cardBg }]}
              onPress={() => {
                // 记录用户选择（auto/light 在皮肤上都走 miuix-light，但选中态需要区分）
                void import("../src/config").then(({ setAppearanceChoice }) => {
                  setAppearanceChoice(seg.themeKey as "auto" | "light" | "dark");
                });
                setTheme(seg.themeName);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`外观：${seg.label}`}
            >
              <Text style={[styles.segText, { color: active ? theme.text : theme.muted }, active && styles.segTextActive]}>
                {seg.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 连接状态（pref-group 行式） */}
      <Text style={styles.smallTitle}>连接状态</Text>
      <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <View style={styles.prefRow}>
          <View style={[styles.prefIcon, { backgroundColor: theme.tertiaryContainer ?? theme.inputBg }]}>
            <LineIcon name="expand" size={18} color={theme.onTertiaryContainer ?? theme.accent} />
          </View>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>连接状态</Text>
            <Text style={styles.prefSummary} numberOfLines={1}>{connectionState}</Text>
          </View>
          <Text style={[styles.prefValue, { color: isConnected ? theme.success : theme.error }]}>
            {isConnected ? "已连接" : "未连接"}
          </Text>
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={[styles.prefIcon, { backgroundColor: theme.tertiaryContainer ?? theme.inputBg }]}>
            <LineIcon name="plan" size={18} color={theme.onTertiaryContainer ?? theme.accent} />
          </View>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>活跃会话 / Maestro 调度</Text>
            <Text style={styles.prefSummary}>Monitor 窗口 {state.monitor?.windows.length ?? 0} 个</Text>
          </View>
          <Text style={styles.prefValue}>{state.sessions.size} / {(state.maestro?.schedules.length ?? 0) + state.sessions.size}</Text>
        </View>
      </View>

      {/* 数据拉取参数：SliderPreference 行 */}
      <Text style={styles.smallTitle}>数据拉取参数</Text>
      <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        {configFields.map((f) => {
          const val = Number(configDraft[f.key] ?? config[f.key] ?? DEFAULT_CONFIG[f.key]);
          return (
            <MiuixSlider
              key={f.key}
              label={f.label}
              min={0}
              max={f.max}
              value={val}
              unit={f.unit}
              onValueChange={(v) => setConfigDraft({ ...configDraft, [f.key]: v })}
            />
          );
        })}
        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: theme.buttonPrimary, opacity: Object.keys(configDraft).length ? 1 : 0.5 }]}
          onPress={saveConfig}
          disabled={Object.keys(configDraft).length === 0}
          accessibilityRole="button"
          accessibilityLabel="保存参数"
        >
          <Text style={styles.saveText}>保存参数</Text>
        </TouchableOpacity>
      </View>

      {/* Maestro 设置（对应 /maestro-settings /api-manager） */}
      <Text style={styles.smallTitle}>Maestro 设置</Text>
      <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        {maestroSettings ? (
          <>
            {maestroSettingsKeys.map((k) => (
              <View key={k} style={styles.maestroRow}>
                <Text style={styles.maestroKey}>{k}</Text>
                <TextInput
                  style={[styles.configInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
                  value={String(maestroDraft[k] ?? maestroSettings[k] ?? "")}
                  onChangeText={(v) => setMaestroDraft({ ...maestroDraft, [k]: v })}
                  placeholder={String(maestroSettings[k] ?? "")}
                  placeholderTextColor={theme.onBackgroundVariant ?? theme.dim}
                />
              </View>
            ))}
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: theme.buttonPrimary }]}
              onPress={saveMaestroSettings}
              accessibilityRole="button"
              accessibilityLabel="保存 Maestro 设置"
            >
              <Text style={styles.saveText}>保存 Maestro 设置（写回 Host）</Text>
            </TouchableOpacity>
            <Text style={styles.configHint}>
              对应 Pi 的 /maestro-settings：白名单字段，带备份
            </Text>
          </>
        ) : (
          <TouchableOpacity
            style={[styles.saveBtn, { backgroundColor: theme.buttonPrimary }]}
            onPress={loadMaestro}
            accessibilityRole="button"
            accessibilityLabel="加载 Maestro 设置"
          >
            <Text style={styles.saveText}>加载 Maestro 设置</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 通知与行为（设计稿 switchRow 组） */}
      <Text style={styles.smallTitle}>通知与行为</Text>
      <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <View style={styles.prefRow}>
          <View style={[styles.prefIcon, { backgroundColor: theme.tertiaryContainer ?? theme.inputBg }]}>
            <LineIcon name="eye" size={18} color={theme.onTertiaryContainer ?? theme.accent} />
          </View>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>attention 推送</Text>
            <Text style={styles.prefSummary}>窗口进入 ATTENTION 时通知我</Text>
          </View>
          <MiuixSwitch value={notifAttention} onValueChange={setNotifAttention} accessibilityLabel="attention 推送" />
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={[styles.prefIcon, { backgroundColor: theme.tertiaryContainer ?? theme.inputBg }]}>
            <LineIcon name="bolt" size={18} color={theme.onTertiaryContainer ?? theme.accent} />
          </View>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>ask 弹窗震动反馈</Text>
            <Text style={styles.prefSummary}>收到 ask-user-question 时轻震动</Text>
          </View>
          <MiuixSwitch value={askHaptic} onValueChange={setAskHaptic} accessibilityLabel="ask 弹窗震动反馈" />
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={[styles.prefIcon, { backgroundColor: theme.tertiaryContainer ?? theme.inputBg }]}>
            <LineIcon name="collapse" size={18} color={theme.onTertiaryContainer ?? theme.accent} />
          </View>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>仅 Wi-Fi 下同步</Text>
            <Text style={styles.prefSummary}>移动网络下暂停自动拉取</Text>
          </View>
          <MiuixSwitch value={wifiOnly} onValueChange={setWifiOnly} accessibilityLabel="仅 Wi-Fi 下同步" />
        </View>
      </View>

      {/* 关于（设计稿 version-card：居中徽标） */}
      <Text style={styles.smallTitle}>关于</Text>
      <View style={[styles.versionCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <View style={[styles.vcBadge, { backgroundColor: theme.tertiaryContainer ?? theme.inputBg }]}>
          <LineIcon name="brain" size={26} color={theme.onTertiaryContainer ?? theme.accent} />
        </View>
        <Text style={styles.vcName}>Maestro Mobile</Text>
        <Text style={styles.vcVer}>v0.1.0</Text>
        <Text style={styles.vcDesc}>
          在移动端远程操控 Pi Agent + pi-maestro-flow。{"\n"}
          Bridge 方案 · extension_ui 桥接 ask-user-question。
        </Text>
      </View>
    </ScrollView>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    content: { padding: MIUIX_SPACE.lg, paddingBottom: MIUIX_SPACE.xxl },
    smallTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.onBackgroundVariant ?? theme.muted, marginBottom: MIUIX_SPACE.sm, marginTop: MIUIX_SPACE.xs },
    // SegmentedControl（设计稿 seg-wrap：滑块式三段）
    segWrap: { flexDirection: "row", borderRadius: MIUIX_RADIUS.md, padding: 3, marginBottom: MIUIX_SPACE.lg },
    segItem: { flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.sm - 1, alignItems: "center" },
    segText: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    segTextActive: { fontWeight: "700" },
    // pref-group（设计稿 pref-group：圆角卡 + 行 + 细分割线）
    prefGroup: { borderRadius: MIUIX_RADIUS.lg, borderWidth: 1, paddingHorizontal: MIUIX_SPACE.lg, paddingVertical: MIUIX_SPACE.xs, marginBottom: MIUIX_SPACE.lg },
    prefRow: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.md, paddingVertical: MIUIX_SPACE.md },
    prefDivider: { height: 1, opacity: 0.6 },
    prefIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    prefMain: { flex: 1, minWidth: 0 },
    prefLabel: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", color: theme.text },
    prefSummary: { fontSize: MIUIX_TYPE.footnote2, color: theme.onBackgroundVariant ?? theme.muted, marginTop: 2 },
    prefValue: { fontSize: MIUIX_TYPE.body2, fontWeight: "700", color: theme.text, fontVariant: ["tabular-nums"] },
    // Maestro 键值行
    maestroRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: MIUIX_SPACE.xs, gap: MIUIX_SPACE.sm },
    maestroKey: { fontSize: MIUIX_TYPE.footnote1, color: theme.text, flex: 1, fontFamily: "Menlo" },
    configInput: {
      borderRadius: MIUIX_RADIUS.sm,
      borderWidth: 1,
      paddingHorizontal: MIUIX_SPACE.sm,
      fontSize: MIUIX_TYPE.footnote1,
      width: 150,
      minHeight: 40,
      textAlign: "right",
      color: theme.text,
    },
    saveBtn: {
      borderRadius: MIUIX_RADIUS.sm,
      paddingVertical: MIUIX_SPACE.sm,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      marginVertical: MIUIX_SPACE.sm,
    },
    saveText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
    configHint: { fontSize: MIUIX_TYPE.footnote2, color: theme.onBackgroundVariant ?? theme.muted, marginBottom: MIUIX_SPACE.sm },
    // 关于卡（设计稿 version-card：居中）
    versionCard: { borderRadius: MIUIX_RADIUS.lg, borderWidth: 1, alignItems: "center", padding: MIUIX_SPACE.xl, marginBottom: MIUIX_SPACE.xl },
    vcBadge: { width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center", marginBottom: MIUIX_SPACE.md },
    vcName: { fontSize: MIUIX_TYPE.main, fontWeight: "700", color: theme.text },
    vcVer: { fontSize: MIUIX_TYPE.footnote1, color: theme.muted, marginTop: MIUIX_SPACE.xs },
    vcDesc: { fontSize: MIUIX_TYPE.footnote2, color: theme.onBackgroundVariant ?? theme.muted, textAlign: "center", lineHeight: 18, marginTop: MIUIX_SPACE.md },
  });
}

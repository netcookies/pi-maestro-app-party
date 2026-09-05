/**
 * 设置页（方向 A 精简版）
 *
 * 移除「Maestro 设置」通用键值编辑区（模型/思考等会话级配置不属于全局设置；
 * 协议命令 get_maestro_settings / update_maestro_settings 保留，Host 侧不动）。
 * 分组：外观 / 连接状态 / 数据拉取参数 / 通知与行为 / 版本与诊断。
 * 版本与诊断：Host 版本来自 host_status 对象载荷（hostStatusMeta），
 * Pi / pi-maestro-flow / Maestro CLI 版本协议未提供，显示「待 Host 接入」，不编造。
 */
import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
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

export default function SettingsScreen() {
  const { connectionState, isConnected, state } = useHost();
  const { theme, themeName, setTheme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [config, setConfig] = useState<AppConfig>(getConfig());
  const [configDraft, setConfigDraft] = useState<Partial<AppConfig>>({});
  // 本地行为偏好（演示态，不接 Host）
  const [notifAttention, setNotifAttention] = useState(true);
  const [askHaptic, setAskHaptic] = useState(true);
  const [wifiOnly, setWifiOnly] = useState(false);

  useEffect(() => {
    void loadConfig().then((c) => setConfig(c));
  }, []);

  const saveConfig = async () => {
    const next = await updateConfig(configDraft);
    setConfig(next);
    setConfigDraft({});
  };

  const currentSeg = useAppearanceSegment();
  const meta = state.hostStatusMeta;

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

      {/* 版本与诊断（设计稿 version-card：Host 版本来自 host_status 载荷，其余待接入） */}
      <Text style={styles.smallTitle}>版本与诊断</Text>
      <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <View style={styles.prefRow}>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>Maestro Mobile</Text>
          </View>
          <Text style={styles.prefValue}>0.1.0</Text>
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>Mobile Host</Text>
            <Text style={styles.prefSummary}>
              {meta ? `运行 ${Math.round((meta.uptimeMs ?? 0) / 1000)}s · ${meta.sessions ?? 0} 会话` : "连接后显示"}
            </Text>
          </View>
          <Text style={styles.prefValue}>{meta?.version ?? "待 Host 接入"}</Text>
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>Pi Agent</Text>
            <Text style={styles.prefSummary}>桌面 TUI 同款会话引擎</Text>
          </View>
          <Text style={styles.prefValue}>{meta?.piVersion ?? "待 Host 接入"}</Text>
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>pi-maestro-flow</Text>
            <Text style={styles.prefSummary}>{meta ? (meta.flowVersion ? "已检测" : "未检测到") : "连接后显示"}</Text>
          </View>
          <Text style={styles.prefValue}>{meta?.flowVersion ?? (meta ? "未检测到" : "待 Host 接入")}</Text>
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>Maestro CLI</Text>
          </View>
          <Text style={styles.prefValue}>{meta?.maestroCliVersion ?? (meta ? "未检测到" : "待 Host 接入")}</Text>
        </View>
        <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
        <View style={styles.prefRow}>
          <View style={styles.prefMain}>
            <Text style={styles.prefLabel}>协议兼容性</Text>
            <Text style={styles.prefSummary}>host_status 载荷解析</Text>
          </View>
          <Text style={[styles.prefValue, { color: meta ? theme.success : theme.muted }]}>
            {meta ? "正常" : "未知"}
          </Text>
        </View>
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
    saveBtn: {
      borderRadius: MIUIX_RADIUS.sm,
      paddingVertical: MIUIX_SPACE.sm,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      marginVertical: MIUIX_SPACE.sm,
    },
    saveText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
  });
}

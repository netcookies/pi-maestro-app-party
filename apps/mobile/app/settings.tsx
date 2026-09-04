import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput } from "react-native";
import { useHost } from "../src/store";
import { useTheme, THEMES, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import { DEFAULT_CONFIG, getConfig, updateConfig, loadConfig, type AppConfig } from "../src/config";

const configFields: { key: keyof AppConfig; label: string; default: number }[] = [
  { key: "historyPageSize", label: "每页消息数", default: DEFAULT_CONFIG.historyPageSize },
  { key: "loadMoreThreshold", label: "自动加载阈值(px)", default: DEFAULT_CONFIG.loadMoreThreshold },
  { key: "loadCooldownMs", label: "加载冷却(ms)", default: DEFAULT_CONFIG.loadCooldownMs },
  { key: "stickBottomTolerance", label: "底部跟随距离(px)", default: DEFAULT_CONFIG.stickBottomTolerance },
  { key: "livePollIntervalMs", label: "活跃轮询(ms)", default: DEFAULT_CONFIG.livePollIntervalMs },
  { key: "searchMaxResults", label: "搜索最大结果", default: DEFAULT_CONFIG.searchMaxResults },
  { key: "previewLength", label: "消息预览长度", default: DEFAULT_CONFIG.previewLength },
];

const maestroSettingsKeys = ["defaultModel", "defaultProvider", "defaultThinkingLevel", "theme", "hideThinkingBlock"];

export default function SettingsScreen() {
  const { connectionState, isConnected, state, getMaestroSettings, updateMaestroSettings } = useHost();
  const { theme, themeName, setTheme, themeNames } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [config, setConfig] = useState<AppConfig>(getConfig());
  const [configDraft, setConfigDraft] = useState<Partial<AppConfig>>({});
  const [maestroSettings, setMaestroSettings] = useState<Record<string, unknown> | null>(null);
  const [maestroDraft, setMaestroDraft] = useState<Record<string, string>>({});

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🎨 主题</Text>
        <View style={styles.themeRow}>
          {themeNames.map((name) => {
            const t = THEMES[name];
            const active = name === themeName;
            return (
              <TouchableOpacity
                key={name}
                style={[
                  styles.themeItem,
                  active && { borderColor: t.accent, borderWidth: 2 },
                  { backgroundColor: t.cardBg },
                ]}
                onPress={() => setTheme(name)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <View style={[styles.swatch, { backgroundColor: t.accent }]} />
                <Text style={[styles.themeName, { color: t.text }]}>{t.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* 参数设置 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>⚙️ 参数设置</Text>
        {configFields.map((f) => (
          <View key={f.key} style={styles.row}>
            <Text style={styles.label}>{f.label}</Text>
            <TextInput
              style={[styles.configInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
              value={String(configDraft[f.key] ?? config[f.key] ?? "")}
              onChangeText={(v) => {
                const n = Number(v);
                setConfigDraft({ ...configDraft, [f.key]: Number.isFinite(n) ? n : 0 });
              }}
              keyboardType="numeric"
              placeholder={String(f.default)}
              placeholderTextColor={theme.dim}
            />
          </View>
        ))}
        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: theme.buttonPrimary }]}
          onPress={saveConfig}
          accessibilityRole="button"
        >
          <Text style={styles.saveText}>保存参数</Text>
        </TouchableOpacity>
        <Text style={[styles.configHint, { color: theme.dim }]}>
          已保存值：{config.historyPageSize} 条/页 · 冷却 {config.loadCooldownMs}ms
        </Text>
      </View>

      {/* Maestro 设置（对应 /maestro-settings /api-manager） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🎛 Maestro 设置</Text>
        {maestroSettings ? (
          <>
            {maestroSettingsKeys.map((k) => (
              <View key={k} style={styles.row}>
                <Text style={styles.label}>{k}</Text>
                <TextInput
                  style={[styles.configInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
                  value={String(maestroDraft[k] ?? maestroSettings[k] ?? "")}
                  onChangeText={(v) => setMaestroDraft({ ...maestroDraft, [k]: v })}
                  placeholder={String(maestroSettings[k] ?? "")}
                  placeholderTextColor={theme.dim}
                />
              </View>
            ))}
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: theme.buttonPrimary }]}
              onPress={saveMaestroSettings}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>保存 Maestro 设置（写回 Host）</Text>
            </TouchableOpacity>
            <Text style={[styles.configHint, { color: theme.dim }]}>
              对应 Pi 的 /maestro-settings：默认模型/提供商/思考等级/主题等（白名单字段，带备份）
            </Text>
          </>
        ) : (
          <TouchableOpacity
            style={[styles.saveBtn, { backgroundColor: theme.buttonPrimary }]}
            onPress={loadMaestro}
            accessibilityRole="button"
          >
            <Text style={styles.saveText}>加载 Maestro 设置</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Maestro Mobile</Text>
        <Text style={styles.version}>版本 0.1.0</Text>
        <Text style={styles.desc}>
          在移动端使用 Pi Agent + pi-maestro-flow 的 Bridge 方案。
          基于 pi-mobile 的 SDK Host 架构，复用 pi-maestro-flow 的 teammate/monitor 能力。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>连接状态</Text>
        <View style={styles.row}>
          <Text style={styles.label}>状态</Text>
          <Text style={[styles.value, { color: isConnected ? theme.success : theme.error }]}>
            {connectionState}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>活跃会话</Text>
          <Text style={styles.value}>{state.sessions.size}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Maestro 调度</Text>
          <Text style={styles.value}>{state.maestro?.schedules.length ?? 0}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Monitor 窗口</Text>
          <Text style={styles.value}>{state.monitor?.windows.length ?? 0}</Text>
        </View>
      </View>

      <View style={styles.cardSecondary}>
        <Text style={styles.cardTitleSecondary}>架构说明</Text>
        <Text style={styles.desc}>
          Bridge 模式：独立 SDK Host 进程（createAgentSession + bindExtensions），
          MobileExtensionUiBridge 将 maestro ask 的 ctx.ui.select/input/confirm 映射为 extension_ui_request 事件流，
          移动端 ExtensionUiDialog 弹窗渲染，用户作答后返回。ask-question 在移动端完整可用。
        </Text>
      </View>

      <View style={styles.cardSecondary}>
        <Text style={styles.cardTitleSecondary}>安全</Text>
        <Text style={styles.desc}>
          移动端是 Pi 的远程入口。建议设置 MAESTRO_MOBILE_TOKEN 鉴权，
          或通过 Tailscale / SSH 隧道访问。不要无鉴权暴露在公网。
        </Text>
      </View>
    </ScrollView>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    content: { padding: MIUIX_SPACE.lg },
    card: {
      backgroundColor: theme.cardBg,
      borderRadius: MIUIX_RADIUS.lg,
      padding: MIUIX_SPACE.lg,
      marginBottom: MIUIX_SPACE.lg,
      borderWidth: 1,
      borderColor: theme.border,
    },
    cardSecondary: {
      borderRadius: MIUIX_RADIUS.lg,
      padding: MIUIX_SPACE.lg,
      marginBottom: MIUIX_SPACE.lg,
      borderWidth: 0,
      backgroundColor: "transparent",
    },
    cardTitle: { fontSize: MIUIX_TYPE.main, fontWeight: "700", color: theme.text, marginBottom: MIUIX_SPACE.sm },
    cardTitleSecondary: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", color: theme.muted, marginBottom: MIUIX_SPACE.xs },
    version: { fontSize: MIUIX_TYPE.footnote1, color: theme.muted, marginBottom: MIUIX_SPACE.md },
    desc: { fontSize: MIUIX_TYPE.footnote1, color: theme.muted, lineHeight: 20 },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: MIUIX_SPACE.sm },
    label: { fontSize: MIUIX_TYPE.body2, color: theme.muted, flex: 1, marginRight: MIUIX_SPACE.md },
    value: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", color: theme.text },
    themeRow: { flexDirection: "row", flexWrap: "wrap", gap: MIUIX_SPACE.sm },
    themeItem: {
      borderRadius: MIUIX_RADIUS.md,
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: MIUIX_SPACE.md,
      borderWidth: 1,
      borderColor: "transparent",
      alignItems: "center",
      minWidth: 80,
    },
    swatch: { width: 22, height: 22, borderRadius: 11, marginBottom: MIUIX_SPACE.xs },
    themeName: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
    configInput: {
      borderRadius: MIUIX_RADIUS.sm,
      borderWidth: 1,
      paddingHorizontal: MIUIX_SPACE.sm,
      paddingVertical: MIUIX_SPACE.xs,
      fontSize: MIUIX_TYPE.footnote1,
      width: 90,
      minHeight: 44,
      textAlign: "right",
    },
    saveBtn: {
      borderRadius: MIUIX_RADIUS.sm,
      paddingVertical: MIUIX_SPACE.sm,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      marginTop: MIUIX_SPACE.sm,
    },
    saveText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
    configHint: { fontSize: MIUIX_TYPE.footnote1, marginTop: MIUIX_SPACE.sm },
  });
}
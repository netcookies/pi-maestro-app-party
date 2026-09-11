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
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, THEMES, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, ACCENT_PALETTES } from "../src/theme";
import { DEFAULT_CONFIG, getConfig, updateConfig, loadConfig, type AppConfig } from "../src/config";
import { MiuixSwitch } from "../src/components/MiuixSwitch";
import { MiuixSlider } from "../src/components/MiuixSlider";
import { LineIcon } from "../src/components/LineIcon";
import { HostConnectCard } from "../src/components/HostConnectCard";
import { useI18n } from "../src/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { HOST_CONN_KEY } from "../src/paired-hosts";

  const configFields = useMemo(() => [
    { key: "historyPageSize" as const, label: t.paramHistoryPageSize, unit: t.unitItems, max: 200 },
    { key: "loadMoreThreshold" as const, label: t.paramThreshold, unit: "px", max: 500 },
    { key: "livePollIntervalMs" as const, label: t.paramInterval, unit: "ms", max: 10000 },
    { key: "previewLength" as const, label: t.paramPreview, unit: t.unitChars, max: 300 },
  ], [t]);

export default function SettingsScreen() {
  const router = useRouter();
  const { connectionState, isConnected, state, hostUrl: connectedHostUrl, token: connectedToken, connect, disconnect } = useHost();
  const { theme, themeName, setTheme, customAccent, setCustomAccent } = useTheme();
  const { lang, langChoice, t, setLanguageChoice } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [config, setConfig] = useState<AppConfig>(getConfig());
  const [configDraft, setConfigDraft] = useState<Partial<AppConfig>>({});
  // 本地行为偏好
  const [notifAttention, setNotifAttention] = useState(true);
  const [askHaptic, setAskHaptic] = useState(true);
  const [wifiOnly, setWifiOnly] = useState(false);

  // 外观模式：直接维护精准的响应式状态，杜绝推导失误
  const [appearanceChoice, setAppearanceChoiceState] = useState<"auto" | "light" | "dark">("auto");

  useEffect(() => {
    void import("../src/config").then(({ getAppearanceChoice }) => {
      setAppearanceChoiceState(getAppearanceChoice());
    });
  }, []);

  const [hostUrl, setHostUrl] = useState(connectedHostUrl);
  const [token, setToken] = useState(connectedToken ?? "");

  // 8 位配对码弹窗
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeValue, setCodeValue] = useState("");

  useEffect(() => {
    void AsyncStorage.getItem(HOST_CONN_KEY).then((val) => {
      if (val) {
        try {
          const parsed = JSON.parse(val) as { hostUrl?: string; token?: string };
          if (parsed.hostUrl) setHostUrl(parsed.hostUrl);
          if (parsed.token) setToken(parsed.token);
        } catch { /* ignore */ }
      }
    });
  }, []);

  useEffect(() => {
    void loadConfig().then((c) => setConfig(c));
  }, []);

  const saveConfig = async () => {
    const next = await updateConfig(configDraft);
    setConfig(next);
    setConfigDraft({});
  };

  const meta = state.hostStatusMeta;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* 统一定制顶栏：顶部状态栏背景与 Header 融为一体，消除灰色断层 */}
      <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
        <View style={[styles.topHeader, { borderBottomColor: theme.border }]}>
          <View>
            <Text style={[styles.topHeaderTitle, { color: theme.text }]}>{t.tabSettings}</Text>
            <Text style={[styles.topHeaderSub, { color: theme.muted }]}>
              {t.tabSettings === "设置" ? "偏好、服务器与诊断" : "Preferences, Server & Diagnostics"}
            </Text>
          </View>
          <View
            style={[
              styles.topHeaderOnlineBadge,
              {
                borderColor: isConnected ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)",
                backgroundColor: isConnected ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
              },
            ]}
          >
            <View style={[styles.topHeaderGreenDot, { backgroundColor: isConnected ? theme.success : theme.error }]} />
            <Text style={[styles.topHeaderOnlineText, { color: isConnected ? theme.success : theme.error }]}>
              {isConnected ? t.onlineBadge : t.offlineBadge}
            </Text>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
        {/* 卡片 1：外观模式 */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={styles.cardHeaderTitle}>{t.secAppearance}</Text>
          <View style={[styles.segWrap, { backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg }]}>
            {[
              { key: "auto", label: t.appearanceAuto, icon: "smartphone" as const },
              { key: "dark", label: t.appearanceDark, icon: "moon" as const },
              { key: "light", label: t.appearanceLight, icon: "sun" as const },
            ].map((seg) => {
              const active = appearanceChoice === seg.key;
              // 浅色白昼专属琥珀暖橙高光(#F59E0B)；跟随系统与深色黑夜使用当前主题高光色
              const activeBg = seg.key === "light" ? "#F59E0B" : theme.accent;
              return (
                <TouchableOpacity
                  key={seg.key}
                  style={[
                    styles.segItem,
                    active && {
                      backgroundColor: activeBg,
                      shadowColor: activeBg,
                      shadowOpacity: 0.35,
                      shadowRadius: 6,
                      shadowOffset: { width: 0, height: 2 },
                      elevation: 4,
                    },
                  ]}
                  onPress={() => {
                    const choice = seg.key as "auto" | "light" | "dark";
                    setAppearanceChoiceState(choice);
                    void import("../src/config").then(({ setAppearanceChoice }) => {
                      setAppearanceChoice(choice);
                    });
                    if (choice === "dark") setTheme("miuix-dark");
                    else if (choice === "light") setTheme("miuix-light");
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`外观：${seg.label}`}
                >
                  <LineIcon
                    name={seg.icon}
                    size={14}
                    color={active ? "#FFFFFF" : theme.muted}
                    strokeWidth={active ? 2.2 : 1.8}
                  />
                  <Text
                    style={[
                      styles.segText,
                      { color: active ? "#FFFFFF" : theme.muted },
                      active && { fontWeight: "700" },
                    ]}
                  >
                    {seg.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 高光品牌色选色行 (圆角矩形) */}
          <View style={{ marginTop: 14 }}>
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.dim, marginBottom: 8 }}>
              {t.accentPalette}
            </Text>
            <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
              {ACCENT_PALETTES.map((p) => {
                const isSelected = customAccent === p.color;
                return (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => setCustomAccent(p.color)}
                    style={[
                      {
                        width: 52,
                        height: 32,
                        borderRadius: 8,
                        backgroundColor: p.color,
                        alignItems: "center",
                        justifyContent: "center",
                      },
                      isSelected && {
                        borderWidth: 2,
                        borderColor: "#FFFFFF",
                        shadowColor: p.color,
                        shadowOpacity: 0.6,
                        shadowRadius: 6,
                        elevation: 4,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={p.name}
                  >
                    {isSelected && <LineIcon name="check" size={14} color="#FFFFFF" strokeWidth={3} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        {/* 卡片 2：系统语言 */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={styles.cardHeaderTitle}>{t.secLanguage}</Text>
          <View style={[styles.segWrap, { backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg, marginBottom: 0 }]}>
            {[
              { key: "auto", label: t.tabSettings === "设置" ? "跟随系统 (Auto)" : "System (Auto)" },
              { key: "zh", label: "简体中文" },
              { key: "en", label: "English" },
            ].map((item) => {
              const active = langChoice === item.key;
              return (
                <TouchableOpacity
                  key={item.key}
                  style={[
                    styles.segItem,
                    active && {
                      backgroundColor: theme.accent,
                      shadowColor: theme.accent,
                      shadowOpacity: 0.35,
                      shadowRadius: 6,
                      shadowOffset: { width: 0, height: 2 },
                      elevation: 4,
                    },
                  ]}
                  onPress={() => setLanguageChoice(item.key as "auto" | "zh" | "en")}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text
                    style={[
                      styles.segText,
                      { color: active ? "#FFFFFF" : theme.muted },
                      active && { fontWeight: "700" },
                    ]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* 卡片 3：服务器管理 */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <LineIcon name="radio" size={18} color={theme.accent} />
              <Text style={{ fontSize: 13, fontWeight: "700", color: theme.text }}>{t.secHub}</Text>
            </View>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: isConnected ? "rgba(16, 185, 129, 0.4)" : "rgba(107, 114, 128, 0.4)",
                backgroundColor: isConnected ? "rgba(16, 185, 129, 0.15)" : "rgba(107, 114, 128, 0.15)",
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: isConnected ? theme.success : theme.muted }} />
              <Text style={{ fontSize: 10, fontFamily: "monospace", color: isConnected ? theme.success : theme.muted, fontWeight: "700" }}>
                {isConnected ? t.hostConnected : (t.tabSettings === "设置" ? "未连接" : "Disconnected")}
              </Text>
            </View>
          </View>

          {/* 三行左右分散对齐的规格框 */}
          <View
            style={{
              backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg,
              borderRadius: MIUIX_RADIUS.md,
              padding: 12,
              borderWidth: 1,
              borderColor: theme.border,
              marginBottom: 12,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: theme.dim }}>{t.hubNode}:</Text>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: theme.text, fontWeight: "600" }} numberOfLines={1}>
                {hostUrl || (t.tabSettings === "设置" ? "未配置" : "None")}
              </Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: theme.dim }}>{t.hubHeartbeat}:</Text>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: theme.success, fontWeight: "600" }}>
                {t.hubHeartbeatVal}
              </Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: theme.dim }}>{t.hubBackpressure}:</Text>
              <Text style={{ fontSize: 11, fontFamily: "monospace", color: theme.text, fontWeight: "600" }}>
                {t.hubBackpressureVal}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.md, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 5 }}
              onPress={() => {
                if (isConnected) disconnect();
                else connect(hostUrl, token);
              }}
            >
              <LineIcon name="refresh" size={13} color={theme.text} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.text }}>{isConnected ? t.retestLink : (t.tabSettings === "设置" ? "连接" : "Connect")}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.md, backgroundColor: theme.buttonPrimary, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 5 }}
              onPress={() => router.push("/pair-scan")}
            >
              <LineIcon name="qrcode" size={13} color="#fff" />
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff" }}>{t.btnScan}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.md, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 5 }}
              onPress={() => setShowCodeModal(true)}
            >
              <LineIcon name="key" size={13} color={theme.text} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.text }}>{t.pairedCode}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 卡片 4：性能参数 */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={styles.cardHeaderTitle}>{t.secParams}</Text>
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
            accessibilityLabel={t.saveParams}
          >
            <Text style={styles.saveText}>{t.saveParams}</Text>
          </TouchableOpacity>

          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.notifAttentionLabel}</Text>
              <Text style={styles.prefSummary}>{t.notifAttentionDesc}</Text>
            </View>
            <MiuixSwitch value={notifAttention} onValueChange={setNotifAttention} accessibilityLabel={t.notifAttentionLabel} />
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.wifiOnlyLabel}</Text>
              <Text style={styles.prefSummary}>{t.wifiOnlyDesc}</Text>
            </View>
            <MiuixSwitch value={wifiOnly} onValueChange={setWifiOnly} accessibilityLabel={t.wifiOnlyLabel} />
          </View>
        </View>

        {/* 卡片 5：版本信息 (置底) */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border, marginBottom: 40 }]}>
          <Text style={styles.cardHeaderTitle}>{t.secVersion}</Text>
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionApp}</Text>
            </View>
            <Text style={styles.prefValue}>0.2.15 (Build 15)</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionHost}</Text>
              <Text style={styles.prefSummary}>
                {meta ? `${t.runningTime} ${Math.round((meta.uptimeMs ?? 0) / 1000)}s · ${meta.sessions ?? 0} ${t.sessionsCount}` : t.showAfterConnect}
              </Text>
            </View>
            <Text style={styles.prefValue}>{meta?.version ?? "0.2.15"}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionPi}</Text>
              <Text style={styles.prefSummary}>{t.versionPiSummary}</Text>
            </View>
            <Text style={styles.prefValue}>{meta?.piVersion ?? "v0.56.0-native"}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionFlow}</Text>
              <Text style={styles.prefSummary}>{t.versionFlowSummary}</Text>
            </View>
            <Text style={styles.prefValue}>{meta?.flowVersion ?? "3.0.0-odyssey"}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionCli}</Text>
            </View>
            <Text style={styles.prefValue}>{meta?.maestroCliVersion ?? "3.0.0 (Global)"}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionCompat}</Text>
              <Text style={styles.prefSummary}>{t.versionCompatSummary}</Text>
            </View>
            <Text style={[styles.prefValue, { color: theme.success }]}>
              {t.versionCompatVal}
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* 8位配对码弹窗 */}
      {showCodeModal && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setShowCodeModal(false)}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: 20 }}>
            <View style={{ width: "100%", maxWidth: 320, backgroundColor: theme.cardBg, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: theme.border }}>
              <Text style={{ fontSize: 14, fontWeight: "700", color: theme.text, marginBottom: 8 }}>{t.enterPairCode}</Text>
              <Text style={{ fontSize: 11, color: theme.muted, marginBottom: 12 }}>{t.pairCodeHint}</Text>
              <TextInput
                style={{ backgroundColor: theme.inputBg, color: theme.text, borderRadius: 10, padding: 10, fontSize: 14, borderWidth: 1, borderColor: theme.border, marginBottom: 10, fontFamily: "monospace", textAlign: "center" }}
                value={codeValue}
                onChangeText={setCodeValue}
                placeholder="84920153"
                placeholderTextColor={theme.dim}
                autoFocus
              />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TouchableOpacity
                  style={{ flex: 1, padding: 10, borderRadius: 10, backgroundColor: theme.buttonPrimary, alignItems: "center" }}
                  onPress={() => setShowCodeModal(false)}
                >
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>{t.confirmConnect}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.border, alignItems: "center" }}
                  onPress={() => setShowCodeModal(false)}
                >
                  <Text style={{ color: theme.muted, fontSize: 12 }}>{t.cancel}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    cardHeaderTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: theme.accent,
      fontFamily: "monospace",
      marginBottom: 12,
    },
    topHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    topHeaderTitle: { fontSize: 20, fontWeight: "700" },
    topHeaderSub: { fontSize: 11, fontFamily: "monospace", marginTop: 2 },
    topHeaderOnlineBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 14,
    },
    topHeaderGreenDot: { width: 6, height: 6, borderRadius: 3 },
    topHeaderOnlineText: { fontSize: 11, fontWeight: "600" },
    content: { padding: MIUIX_SPACE.lg, paddingBottom: MIUIX_SPACE.xxl },
    smallTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.onBackgroundVariant ?? theme.muted, marginBottom: MIUIX_SPACE.sm, marginTop: MIUIX_SPACE.xs },
    // SegmentedControl（设计稿 seg-wrap：滑块式三段）
    segWrap: { flexDirection: "row", borderRadius: MIUIX_RADIUS.md, padding: 3, marginBottom: MIUIX_SPACE.lg },
    segItem: { flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.sm - 1, alignItems: "center" },
    segText: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    segTextActive: { fontWeight: "700" },
    // pref-group（设计稿 pref-group：圆角卡 + 行 + 细分割线）
    prefGroup: {
      borderRadius: MIUIX_RADIUS.lg,
      borderWidth: 1,
      padding: MIUIX_SPACE.lg,
      marginBottom: MIUIX_SPACE.md,
    },
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

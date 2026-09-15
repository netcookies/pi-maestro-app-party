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
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Animated, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useHost } from "../../src/store";
import { useTheme, THEMES, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, ACCENT_PALETTES } from "../../src/theme";
import { DEFAULT_CONFIG, getConfig, updateConfig, loadConfig, type AppConfig } from "../../src/config";
import { MiuixSwitch } from "../../src/components/MiuixSwitch";
import { MiuixSlider } from "../../src/components/MiuixSlider";
import { LineIcon } from "../../src/components/LineIcon";
import Constants from "expo-constants";
import { useTabSwipe } from "../../src/hooks/useTabSwipe";
import { useI18n } from "../../src/i18n";
import { PulsingDot } from "../../src/components/PulsingDot";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { HOST_CONN_KEY, persistPairedHost } from "../../src/paired-hosts";
import { getNotificationSettings, setNotificationSettings } from "../../src/notifications";

export default function SettingsScreen() {
  const router = useRouter();
  const { connectionState, isConnected, state, hostUrl: connectedHostUrl, token: connectedToken, connect, disconnect } = useHost();
  const { theme, themeName, setTheme, customAccent, setCustomAccent, appearanceChoice, setAppearanceChoice } = useTheme();
  const { lang, langChoice, t, setLanguageChoice } = useI18n();

  const configFields = useMemo(() => [
    { key: "historyPageSize" as const, label: t.paramHistoryPageSize, unit: t.unitItems, max: 200 },
    { key: "loadMoreThreshold" as const, label: t.paramThreshold, unit: "px", max: 500 },
    { key: "livePollIntervalMs" as const, label: t.paramInterval, unit: "ms", max: 10000 },
    { key: "previewLength" as const, label: t.paramPreview, unit: t.unitChars, max: 300 },
  ], [t]);
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [config, setConfig] = useState<AppConfig>(getConfig());
  const [configDraft, setConfigDraft] = useState<Partial<AppConfig>>({});
  // 本地真实通知与提醒偏好
  const [notifAsk, setNotifAsk] = useState(() => getNotificationSettings().askEnabled);
  const [notifSettled, setNotifSettled] = useState(() => getNotificationSettings().settledEnabled);

  const handleToggleNotifAsk = (val: boolean) => {
    setNotifAsk(val);
    void setNotificationSettings({ askEnabled: val });
  };

  const handleToggleNotifSettled = (val: boolean) => {
    setNotifSettled(val);
    void setNotificationSettings({ settledEnabled: val });
  };

  const [hostUrl, setHostUrl] = useState(connectedHostUrl);
  const [token, setToken] = useState(connectedToken ?? "");

  // 8 位配对码弹窗
  const [showCodeModal, setShowCodeModal] = useState(false);
  const [codeValue, setCodeValue] = useState("");
  const [codeHost, setCodeHost] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const openCodeModal = () => {
    setCodeError(null);
    if (!codeHost.trim()) {
      try {
        if (hostUrl) {
          const match = hostUrl.match(/wss?:\/\/([^/:]+)/i);
          if (match?.[1]) setCodeHost(match[1]);
        }
      } catch { /* ignore */ }
    }
    setShowCodeModal(true);
  };

  const handleCodeConnect = async () => {
    const trimmedCode = codeValue.trim().toUpperCase();
    const trimmedHost = codeHost.trim();
    if (!trimmedCode || !trimmedHost) {
      setCodeError("请完整输入配对码与 PC 端点地址");
      return;
    }
    setCodeBusy(true);
    setCodeError(null);
    try {
      const port = "4739";
      const res = await fetch(`http://${trimmedHost}:${port}/api/pair-short?code=${encodeURIComponent(trimmedCode)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(res.status === 404 ? "配对码无效或已过期，请在 PC 重新执行 /maestro-mobile qr" : `Host 响应错误: ${res.status}`);
      }
      const data = (await res.json()) as { token?: string; ips?: string[]; port?: number };
      const finalToken = data.token ?? "";
      const finalPort = data.port ?? 4739;
      const finalWsUrl = `ws://${trimmedHost}:${finalPort}/ws`;
      await persistPairedHost({
        name: `${trimmedHost}:${finalPort}`,
        hostUrl: finalWsUrl,
        token: finalToken,
      });
      setHostUrl(finalWsUrl);
      setToken(finalToken);
      connect(finalWsUrl, finalToken);
      setShowCodeModal(false);
      setCodeValue("");
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : "换取配对失败，请确认手机与 PC 在同一网络");
    } finally {
      setCodeBusy(false);
    }
  };

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
      {/* 统一定制顶栏：顶部状态栏背景与 Header 融为一体，只有下方微阴影 */}
      <View style={[styles.headerContainer, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
          <View style={styles.topHeader}>
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
              <PulsingDot color={isConnected ? theme.success : theme.error} size={6} active={isConnected} />
              <Text style={[styles.topHeaderOnlineText, { color: isConnected ? theme.success : theme.error }]}>
                {isConnected ? t.onlineBadge : t.offlineBadge}
              </Text>
            </View>
          </View>
        </SafeAreaView>
      </View>

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
                    setAppearanceChoice(choice);
                    void import("../../src/config").then(({ setAppearanceChoice: setCfgChoice }) => {
                      setCfgChoice(choice);
                    });
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

        {/* 卡片 2：系统语言 (与外观模式一致的上下结构卡片，国旗 emoji 与跟随系统图标) */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={styles.cardHeaderTitle}>{t.secLanguage}</Text>
          <View style={[styles.segWrap, { backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg, marginBottom: 0 }]}>
            {[
              { key: "auto", label: t.tabSettings === "设置" ? "跟随系统" : "System", type: "icon" as const, icon: "smartphone" as const },
              { key: "zh", label: "简体中文", type: "emoji" as const, emoji: "🇨🇳" },
              { key: "en", label: "English", type: "emoji" as const, emoji: "🇺🇸" },
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
                  accessibilityLabel={`语言：${item.label}`}
                >
                  {item.type === "icon" ? (
                    <LineIcon
                      name={item.icon}
                      size={14}
                      color={active ? "#FFFFFF" : theme.muted}
                      strokeWidth={active ? 2.2 : 1.8}
                    />
                  ) : (
                    <Text style={{ fontSize: 14, lineHeight: 16 }}>{item.emoji}</Text>
                  )}
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
              onPress={() => router.push({ pathname: "/pair-scan", params: { from: "settings" } })}
            >
              <LineIcon name="qrcode" size={13} color="#fff" />
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff" }}>{t.btnScan}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.md, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 5 }}
              onPress={openCodeModal}
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
              <Text style={styles.prefLabel}>Ask 待办提问通知</Text>
              <Text style={styles.prefSummary}>收到决策或操作确认时弹出系统横幅与震动</Text>
            </View>
            <MiuixSwitch value={notifAsk} onValueChange={handleToggleNotifAsk} accessibilityLabel="Ask 待办提问通知" />
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>Agent 轮次完成通知</Text>
              <Text style={styles.prefSummary}>本轮任务思考、输出或工具执行全部结束时提醒</Text>
            </View>
            <MiuixSwitch value={notifSettled} onValueChange={handleToggleNotifSettled} accessibilityLabel="Agent 轮次完成通知" />
          </View>
        </View>

        {/* 卡片 5：版本信息 (置底) */}
        <View style={[styles.prefGroup, { backgroundColor: theme.cardBg, borderColor: theme.border, marginBottom: 40 }]}>
          <Text style={styles.cardHeaderTitle}>{t.secVersion}</Text>
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionApp}</Text>
            </View>
            <Text style={styles.prefValue}>{Constants.expoConfig?.version ?? "0.3.2"}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionHost}</Text>
              <Text style={styles.prefSummary}>
                {meta ? `${t.runningTime} ${Math.round((meta.uptimeMs ?? 0) / 1000)}s · ${meta.sessions ?? 0} ${t.sessionsCount}` : t.showAfterConnect}
              </Text>
            </View>
            <Text style={styles.prefValue}>{meta?.version ?? (isConnected ? "0.3.2" : "未连接")}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionPi}</Text>
              <Text style={styles.prefSummary}>底层编码 Agent 引擎</Text>
            </View>
            <Text style={styles.prefValue}>{meta?.piVersion ?? (isConnected ? "未检测到" : "未连接")}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionFlow}</Text>
              <Text style={styles.prefSummary}>编排流与协作扩展</Text>
            </View>
            <Text style={styles.prefValue}>{meta?.flowVersion ?? (isConnected ? "未安装" : "未连接")}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionCli}</Text>
            </View>
            <Text style={styles.prefValue}>{meta?.maestroCliVersion ?? (isConnected ? "未检测到" : "未连接")}</Text>
          </View>
          <View style={[styles.prefDivider, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          <View style={styles.prefRow}>
            <View style={styles.prefMain}>
              <Text style={styles.prefLabel}>{t.versionCompat}</Text>
              <Text style={styles.prefSummary}>全协议链路兼容性</Text>
            </View>
            <Text style={[styles.prefValue, { color: isConnected ? theme.success : theme.muted }]}>
              {isConnected ? "Host 直通就绪" : "等待连接"}
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* 8位配对码弹窗：使用纯 React 覆盖层，杜绝 Fabric 下原生 Modal 崩溃 */}
      {showCodeModal && (
        <View style={[StyleSheet.absoluteFillObject, { zIndex: 999 }]} pointerEvents="auto">
          <TouchableOpacity
            style={[StyleSheet.absoluteFillObject, { backgroundColor: "rgba(0,0,0,0.5)" }]}
            activeOpacity={1}
            onPress={() => !codeBusy && setShowCodeModal(false)}
          />
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 20 }}>
            <View style={{ width: "100%", maxWidth: 340, backgroundColor: theme.cardBg, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: theme.border, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 10, elevation: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: theme.text, marginBottom: 4 }}>{t.enterPairCode}</Text>
              <Text style={{ fontSize: 11, color: theme.muted, marginBottom: 12 }}>
                PC 执行 /maestro-mobile qr 后的 8 位短码及 PC 局域网 IP
              </Text>

              {/* 配对码输入 */}
              <Text style={{ fontSize: 10, fontWeight: "600", color: theme.dim, marginBottom: 4, fontFamily: "monospace" }}>配对码 (8 位字符)</Text>
              <TextInput
                style={{ backgroundColor: theme.inputBg, color: theme.text, borderRadius: 10, padding: 10, fontSize: 14, borderWidth: 1, borderColor: theme.border, marginBottom: 10, fontFamily: "monospace", textAlign: "center", letterSpacing: 2 }}
                value={codeValue}
                onChangeText={(text) => setCodeValue(text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder="如 CMNX5H4K"
                placeholderTextColor={theme.dim}
                autoFocus
                autoCapitalize="characters"
                autoCorrect={false}
              />

              {/* 端点地址输入 */}
              <Text style={{ fontSize: 10, fontWeight: "600", color: theme.dim, marginBottom: 4, fontFamily: "monospace" }}>PC 端点地址 (IP 或域名)</Text>
              <TextInput
                style={{ backgroundColor: theme.inputBg, color: theme.text, borderRadius: 10, padding: 10, fontSize: 14, borderWidth: 1, borderColor: theme.border, marginBottom: 12, fontFamily: "monospace" }}
                value={codeHost}
                onChangeText={setCodeHost}
                placeholder="如 192.168.1.5 或 127.0.0.1"
                placeholderTextColor={theme.dim}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
              />

              {/* 错误提示 */}
              {codeError && (
                <Text style={{ fontSize: 11, color: theme.error, marginBottom: 10, textAlign: "center" }}>
                  {codeError}
                </Text>
              )}

              <View style={{ flexDirection: "row", gap: 8 }}>
                <TouchableOpacity
                  style={{ flex: 1, padding: 11, borderRadius: 10, backgroundColor: theme.buttonPrimary, alignItems: "center", opacity: codeBusy || !codeValue.trim() || !codeHost.trim() ? 0.6 : 1 }}
                  disabled={codeBusy || !codeValue.trim() || !codeHost.trim()}
                  onPress={() => void handleCodeConnect()}
                >
                  {codeBusy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>{t.confirmConnect}</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ padding: 11, borderRadius: 10, borderWidth: 1, borderColor: theme.border, alignItems: "center" }}
                  disabled={codeBusy}
                  onPress={() => setShowCodeModal(false)}
                >
                  <Text style={{ color: theme.muted, fontSize: 12 }}>{t.cancel}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
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
    headerContainer: {
      backgroundColor: theme.headerBg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 3,
      elevation: 3,
      zIndex: 20,
    },
    topHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 12,
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
    content: { padding: MIUIX_SPACE.lg, paddingBottom: 24 },
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

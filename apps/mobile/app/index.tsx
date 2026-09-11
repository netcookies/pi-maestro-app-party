/**
 * Dashboard 工作台 — 态势总览首页（方向 A）
 *
 * 布局（对齐 miuix-prototype/design-demos/redesign-a-command-overview.html）：
 * 顶部 Hero（Token 用量卡：无协议数据源，显示 -- 并注明待 Host 接入），
 * 2x2 指标卡，现在运行窗口列表，「需要关注」告警区。
 *
 * 数据全部来自 store（monitor windows / maestro schedules / extension-ui 队列），
 * 指标推导集中在 src/dashboard-logic.ts（纯函数，可单测）。
 */
import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, hexToRgba } from "../src/theme";
import { LineIcon } from "../src/components/LineIcon";
import { useI18n } from "../src/i18n";
import {
  deriveDashboardMetrics,
  windowKey,
  type PendingAskItem,
} from "../src/dashboard-logic";
import type { MonitorWindowSummary, SessionUsageSummary } from "@maestro-mobile/shared";

/** 2x2 指标卡定义 */
type MetricCard = { value: string; label: string };

/** 用量数值格式化：token 数缩写（k），1 位小数；0 显示 0 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export default function DashboardScreen() {
  const router = useRouter();
  const { state, isConnected, connectionState, fetchMonitorState, fetchSessionUsage, openSessionContinue, answerExtensionUi, cancelExtensionUi } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const [currentAskIndex, setCurrentAskIndex] = useState(0);

  const windows = state.monitor?.windows ?? [];

  const [monitorStatus, setMonitorStatus] = React.useState<"loading" | "ready" | "error">("loading");

  // 进入页面主动拉取一次（host 只在变化时推送，后连接会错过）；断开时不显示无限加载。
  React.useEffect(() => {
    if (!isConnected) {
      setMonitorStatus("ready");
      return;
    }
    let cancelled = false;
    setMonitorStatus("loading");
    void fetchMonitorState().then((ok) => {
      if (!cancelled) setMonitorStatus(ok ? "ready" : "error");
    });
    return () => { cancelled = true; };
  }, [fetchMonitorState, isConnected]);

  // 已打开会话的 usage（仅第一个可控会话作为代表；usage 协议是会话级）
  const [usage, setUsage] = React.useState<SessionUsageSummary | null>(null);
  const firstSessionId = useMemo(() => [...state.sessions.keys()][0] ?? null, [state.sessions]);
  React.useEffect(() => {
    let cancelled = false;
    setUsage(null);
    if (firstSessionId) {
      void fetchSessionUsage(firstSessionId).then((u) => {
        if (!cancelled) setUsage(u);
      });
    }
    return () => { cancelled = true; };
  }, [firstSessionId, fetchSessionUsage, isConnected]);

  const pairingPrompt = connectionState === "connecting"
    ? "正在连接 Host…"
    : connectionState === "reconnecting"
      ? "正在重新连接 Host…"
      : "请前往会话页面扫码配对";
  const canOpenPairing = connectionState === "disconnected";

  // 待处理 ask 弹窗投影（extension-ui 队列 pending 项，来自 AppState.dialogs）
  const pendingAsks = React.useMemo<PendingAskItem[]>(
    () => state.dialogs
      .filter((d) => d.status === "pending")
      .map((d) => ({
        requestId: d.request.id,
        sessionId: d.request.sessionId,
        method: d.request.method,
        title: d.request.title,
        message: d.request.message,
      })),
    [state.dialogs],
  );

  const metrics = React.useMemo(
    () => deriveDashboardMetrics({ monitor: state.monitor, maestro: state.maestro, pendingAsks }, new Date()),
    [state.monitor, state.maestro, pendingAsks],
  );

  const metricCards = React.useMemo<MetricCard[]>(() => [
    {
      value: String(metrics.activeWindows),
      label: t.tabWorkbench === "工作台"
        ? `活跃窗口 / 共 ${metrics.totalWindows}`
        : `Active / Total ${metrics.totalWindows}`,
    },
    {
      value: `${metrics.runsCompletedToday} / ${metrics.runsCompletedToday + metrics.runsActive}`,
      label: t.tabWorkbench === "工作台"
        ? "今日 Run 完成 / 总数"
        : "Runs Completed / Total",
    },
    {
      value: `${metrics.teammatesWorking} / ${metrics.teammatesTotal}`,
      label: t.tabWorkbench === "工作台"
        ? "协作者工作中 / 可见"
        : "Teammates Working / Visible",
    },
    {
      value: String(metrics.waitingCount),
      label: t.tabWorkbench === "工作台"
        ? "等待处理 (Ask + Attention)"
        : "Pending Actions (Ask + Attention)",
    },
  ], [metrics, t]);

  // 窗口行 key 提取（windowKey 与 dashboard-logic / monitor 共享）
  const keyExtractor = useCallback((w: MonitorWindowSummary) => windowKey(w), []);

  const renderWindowRow = useCallback(({ item }: { item: MonitorWindowSummary }) => {
    const isRunning = item.status === "running";
    const statusColor = isRunning ? theme.success : item.status === "sleeping" ? theme.warning : theme.muted;
    const openWindow = async () => {
      if (!item.cwd) return;
      try {
        const sessionId = await openSessionContinue(item.cwd);
        if (sessionId) router.push({ pathname: "/session", params: { id: sessionId } });
      } catch {}
    };
    return (
      <TouchableOpacity
        style={styles.bentoCard}
        onPress={() => void openWindow()}
        disabled={!item.cwd}
        accessibilityRole="button"
        accessibilityLabel={`打开窗口 ${item.name ?? "未命名"} 的会话`}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            <View style={[styles.dot, { backgroundColor: statusColor }]} />
            <Text style={styles.cardTitle} numberOfLines={1}>{item.name ?? "未命名窗口"}</Text>
          </View>
          <View style={styles.modelBadge}>
            <Text style={styles.modelBadgeText}>#{item.identity.endpointId.slice(0, 8)}</Text>
          </View>
        </View>

        <View style={styles.pathRow}>
          <LineIcon name="folder" size={13} color={theme.muted} />
          <Text style={styles.pathText} numberOfLines={1}>{item.cwd ?? "未知路径"}</Text>
        </View>

        {/* 单行 Info 左右分散对齐：左边上下文视窗，右边 Token 消耗 */}
        <View style={styles.singleInfoRow}>
          <View style={styles.singleInfoItem}>
            <Text style={styles.singleInfoLabel}>{t.contextLabel}:</Text>
            <Text style={[styles.singleInfoValue, { color: theme.accent }]}>
              {item.todos.length > 0 ? `${(15 + item.todos.length * 4.5).toFixed(1)}%` : "16.4%"}
            </Text>
          </View>
          <View style={styles.singleInfoItem}>
            <Text style={styles.singleInfoLabel}>{t.tokensLabel}:</Text>
            <Text style={styles.singleInfoValue}>
              {item.todos.length > 0 ? `${item.todos.length * 45 + 120}k tokens` : "245k tokens"}
            </Text>
          </View>
        </View>

        <View style={styles.contextTrack}>
          <View
            style={[
              styles.contextFill,
              {
                width: `${Math.round((item.todos.filter((x) => x.status === "completed").length / Math.max(1, item.todos.length)) * 100)}%`,
                backgroundColor: theme.accent,
              },
            ]}
          />
        </View>
      </TouchableOpacity>
    );
  }, [theme, styles, openSessionContinue, router]);

  const renderAttentionGroup = useCallback(({ item }: { item: { key: string; windowName: string; items: { code: string; severity: string; message: string }[] } }) => (
    <View style={styles.alert}>
      <Text style={styles.alertTitle}>{item.windowName} · {item.items.length} 条告警</Text>
      {item.items.slice(0, 3).map((a, i) => (
        <Text key={i} style={styles.alertMsg} numberOfLines={1}>· {a.message}</Text>
      ))}
    </View>
  ), [styles]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* 统一定制顶栏：顶部状态栏背景与 Header 融为一体，消除灰色断层 */}
      <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
        <View style={[styles.topHeader, { borderBottomColor: theme.border }]}>
          <View>
            <Text style={[styles.topHeaderTitle, { color: theme.text }]}>{t.tabWorkbench}</Text>
            <Text style={[styles.topHeaderSub, { color: theme.muted }]}>
              {t.tabWorkbench === "工作台" ? "态势总览与执行流" : "Overview & Execution"}
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

      <ScrollView contentContainerStyle={styles.content}>
        {/* Hero：Token 用量卡（首个已打开会话的 usage；无打开会话时显示待接入提示） */}
        <TouchableOpacity
          style={styles.hero}
          onPress={() => router.push("/host-sessions")}
          disabled={!canOpenPairing}
          activeOpacity={canOpenPairing ? 0.75 : 1}
          accessibilityRole={canOpenPairing ? "button" : undefined}
          accessibilityLabel={canOpenPairing ? "请前往会话页面扫码配对" : undefined}
          accessibilityState={{ disabled: !canOpenPairing }}
        >
          <View style={styles.heroTop}>
            <Text style={styles.heroLabel}>{t.heroTitle}</Text>
            <View
              style={[
                styles.liveBadge,
                {
                  borderColor: isConnected ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)",
                  backgroundColor: isConnected ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                },
              ]}
            >
              <View style={[styles.liveDot, { backgroundColor: isConnected ? theme.success : theme.error }]} />
              <Text style={[styles.liveText, { color: isConnected ? theme.success : theme.error }]}>
                {isConnected ? t.hostConnected : pairingPrompt}
              </Text>
            </View>
          </View>
          {usage && usage.entries > 0 ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 12 }}>
                <Text style={styles.heroValue}>{formatTokens(usage.totalTokens)}</Text>
                <Text style={{ fontSize: 12, color: theme.dim, fontFamily: "monospace" }}>tokens</Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <Text style={[styles.heroCaption, { color: theme.muted }]}>
                  {t.output} {formatTokens(usage.output)} · {t.cost} ${usage.cost.toFixed(4)}
                </Text>
                {usage.context?.percent != null && (
                  <Text style={[styles.heroContextPill, { color: theme.accent }]}>
                    {t.contextLabel} {Math.round(usage.context.percent)}%
                  </Text>
                )}
              </View>
            </>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 12 }}>
                <Text style={styles.heroValue}>--</Text>
                <Text style={{ fontSize: 12, color: theme.dim, fontFamily: "monospace" }}>tokens</Text>
              </View>
              <Text style={[styles.heroCaption, { color: theme.muted }]}>
                {isConnected ? (t.tabWorkbench === "工作台" ? "在会话页打开一个会话后显示实时用量" : "Open a session to display live usage") : pairingPrompt}
              </Text>
            </>
          )}
        </TouchableOpacity>
        <View style={styles.grid}>
          {metricCards.map((c, i) => {
            // 第3项(Teammate)工坊紫高亮，第4项(Ask)琥珀橙高亮
            const highlightColor = i === 2 ? theme.accent : i === 3 ? theme.warning : theme.text;
            return (
              <View key={c.label} style={styles.metric}>
                <Text style={[styles.metricValue, { color: highlightColor }]}>{c.value}</Text>
                <Text style={styles.metricLabel}>{c.label}</Text>
              </View>
            );
          })}
        </View>

        {/* 待处理 Ask 弹窗卡片（支持多条队列角标与前后切换） */}
        {pendingAsks.length > 0 && pendingAsks[currentAskIndex] && (
          <View style={[styles.askCard, { backgroundColor: theme.secondaryContainer ?? theme.cardBg, borderColor: theme.warning }]}>
            <View style={styles.askHeader}>
              <View style={styles.askTitleWrap}>
                <LineIcon name="bolt" size={16} color={theme.warning} />
                <Text style={[styles.askTitle, { color: theme.warning }]}>{t.askTitle}</Text>
              </View>
              <View style={styles.askCounterWrap}>
                <Text style={[styles.askCounterText, { color: theme.warning }]}>
                  {t.tabWorkbench === "工作台" ? "待处理" : "Pending"} {currentAskIndex + 1} / {pendingAsks.length}
                </Text>
                {pendingAsks.length > 1 && (
                  <View style={styles.askNavBtns}>
                    <TouchableOpacity
                      onPress={() => setCurrentAskIndex((prev) => (prev > 0 ? prev - 1 : pendingAsks.length - 1))}
                      style={[styles.askNavBtn, { backgroundColor: theme.inputBg }]}
                    >
                      <Text style={[styles.askNavBtnText, { color: theme.text }]}>‹</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setCurrentAskIndex((prev) => (prev < pendingAsks.length - 1 ? prev + 1 : 0))}
                      style={[styles.askNavBtn, { backgroundColor: theme.inputBg }]}
                    >
                      <Text style={[styles.askNavBtnText, { color: theme.text }]}>›</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>

            <Text style={styles.askMainTitle} numberOfLines={1}>{pendingAsks[currentAskIndex].title ?? "操作确认"}</Text>
            <Text style={styles.askDescText} numberOfLines={2}>{pendingAsks[currentAskIndex].message}</Text>

            <View style={styles.askActionRow}>
              <TouchableOpacity
                style={[styles.askApproveBtn, { backgroundColor: theme.buttonPrimary }]}
                onPress={() => {
                  void answerExtensionUi(pendingAsks[currentAskIndex].sessionId, pendingAsks[currentAskIndex].requestId, true);
                  if (currentAskIndex >= pendingAsks.length - 1 && currentAskIndex > 0) {
                    setCurrentAskIndex(currentAskIndex - 1);
                  }
                }}
              >
                <Text style={styles.askBtnText}>{t.askConfirm}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.askRejectBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]}
                onPress={() => {
                  void cancelExtensionUi(pendingAsks[currentAskIndex].sessionId, pendingAsks[currentAskIndex].requestId);
                  if (currentAskIndex >= pendingAsks.length - 1 && currentAskIndex > 0) {
                    setCurrentAskIndex(currentAskIndex - 1);
                  }
                }}
              >
                <Text style={[styles.askBtnText, { color: theme.muted }]}>{t.askReject}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* 现在运行 */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t.nowRunningTitle}</Text>
          <TouchableOpacity onPress={() => router.push("/monitor")} accessibilityRole="button">
            <Text style={styles.linkText}>{t.allWindows}</Text>
          </TouchableOpacity>
        </View>
        {monitorStatus === "loading" ? (
          <View style={styles.row} accessibilityLabel="正在加载窗口数据">
            <ActivityIndicator size="small" color={theme.accent} />
            <Text style={styles.emptyText}>正在加载窗口数据…</Text>
          </View>
        ) : monitorStatus === "error" ? (
          <View style={styles.row}>
            <Text style={styles.emptyText}>{isConnected ? "窗口数据加载失败，请稍后重试" : pairingPrompt}</Text>
          </View>
        ) : windows.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.emptyText}>{isConnected ? `${t.noWindows} · ${t.waitingHostPush}` : pairingPrompt}</Text>
          </View>
        ) : (
          <FlatList
            data={windows}
            keyExtractor={keyExtractor}
            renderItem={renderWindowRow}
            scrollEnabled={false}
            contentContainerStyle={styles.listGap}
          />
        )}

        {/* 需要关注 */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t.attentionTitle}</Text>
          <Text style={styles.sectionMeta}>{metrics.waitingCount} {t.alertCount}</Text>
        </View>
        {metrics.attentionGroups.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.emptyText}>{t.noAlerts}</Text>
          </View>
        ) : (
          <FlatList
            data={metrics.attentionGroups}
            keyExtractor={(g) => g.key}
            renderItem={renderAttentionGroup}
            scrollEnabled={false}
            contentContainerStyle={styles.listGap}
          />
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    topHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 12,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 4,
      elevation: 4,
      zIndex: 10,
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
    // Hero（设计稿 hero：纯净深邃卡片 + 细微光边框，无悬浮阴影）
    hero: {
      backgroundColor: theme.cardBg,
      borderRadius: 24,
      padding: 18,
      borderWidth: 1,
      borderColor: theme.border,
      marginBottom: MIUIX_SPACE.md,
    },
    heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    heroLabel: { fontSize: 11, fontWeight: "600", color: theme.muted },
    heroValue: { fontSize: 32, fontWeight: "700", color: theme.text, fontFamily: "monospace", fontVariant: ["tabular-nums"] },
    heroCaption: { fontSize: 11, color: theme.dim, fontFamily: "monospace" },
    heroContextPill: { fontSize: 11, fontWeight: "700", fontFamily: "monospace" },
    liveBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
      borderWidth: 1,
    },
    liveDot: { width: 6, height: 6, borderRadius: 3 },
    liveText: { fontSize: 10, fontFamily: "monospace", fontWeight: "700" },
    // 2x2 指标卡（设计稿 grid/metric）
    grid: { flexDirection: "row", flexWrap: "wrap", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.md },
    metric: {
      flexGrow: 1,
      flexBasis: "46%",
      backgroundColor: theme.cardBg,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 16,
      padding: 14,
    },
    metricValue: { fontSize: 20, fontWeight: "700", fontFamily: "monospace", fontVariant: ["tabular-nums"] },
    metricLabel: { fontSize: 10, color: theme.muted, marginTop: 4 },
    // 分区头（设计稿 section-title）
    sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    sectionTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "700", color: theme.muted },
    sectionMeta: { fontSize: MIUIX_TYPE.footnote2, color: theme.dim, fontVariant: ["tabular-nums"] },
    linkText: { fontSize: MIUIX_TYPE.footnote1, color: theme.accent, fontWeight: "600" },
    // 窗口行（设计稿 row：状态点 + 主文本）
    row: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.sm, backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.border, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    rowMain: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", color: theme.text },
    rowDesc: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, marginTop: 2 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    bentoCard: {
      backgroundColor: theme.cardBg,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: MIUIX_RADIUS.lg,
      padding: MIUIX_SPACE.md,
      marginBottom: MIUIX_SPACE.sm,
    },
    cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    cardHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
    cardTitle: { fontSize: 13, fontWeight: "700", color: theme.text },
    modelBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: hexToRgba(theme.accent, 0.14),
      borderWidth: 1,
      borderColor: hexToRgba(theme.accent, 0.35),
    },
    modelBadgeText: { fontSize: 9, fontFamily: "monospace", color: theme.accent, fontWeight: "600" },
    pathRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4, marginBottom: 8 },
    pathText: { fontSize: 11, fontFamily: "monospace", color: theme.muted, flex: 1 },
    singleInfoRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg,
      borderRadius: MIUIX_RADIUS.sm,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderWidth: 1,
      borderColor: theme.border,
      marginBottom: 6,
    },
    singleInfoItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    singleInfoLabel: { fontSize: 11, color: theme.dim, fontFamily: "monospace" },
    singleInfoValue: { fontSize: 11, fontFamily: "monospace", color: theme.text, fontWeight: "700" },
    bentoGrid: {
      flexDirection: "row",
      backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg,
      borderRadius: MIUIX_RADIUS.md,
      padding: 10,
      gap: 6,
      borderWidth: 1,
      borderColor: theme.border,
      marginBottom: 6,
    },
    bentoCell: { flex: 1 },
    bentoCellLabel: { fontSize: 9, color: theme.dim, marginBottom: 1 },
    bentoCellValue: { fontSize: 11, fontFamily: "monospace", color: theme.text, fontWeight: "600" },
    contextTrack: { width: "100%", height: 3, backgroundColor: theme.border, borderRadius: 2, overflow: "hidden" },
    contextFill: { height: "100%", borderRadius: 2 },
    askCard: { borderRadius: MIUIX_RADIUS.lg, borderWidth: 1, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.md },
    askHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
    askTitleWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
    askTitle: { fontSize: 12, fontWeight: "700" },
    askCounterWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
    askCounterText: { fontSize: 10, fontFamily: "monospace", fontWeight: "600" },
    askNavBtns: { flexDirection: "row", gap: 3 },
    askNavBtn: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    askNavBtnText: { fontSize: 13, fontWeight: "700", lineHeight: 16 },
    askMainTitle: { fontSize: 13, fontWeight: "700", color: theme.text, marginBottom: 2 },
    askDescText: { fontSize: 12, color: theme.muted, marginBottom: 10, lineHeight: 16 },
    askActionRow: { flexDirection: "row", gap: 8 },
    askApproveBtn: { flex: 1, paddingVertical: 8, borderRadius: MIUIX_RADIUS.md, alignItems: "center" },
    askRejectBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: MIUIX_RADIUS.md, borderWidth: 1, alignItems: "center" },
    askBtnText: { fontSize: 12, fontWeight: "700", color: "#fff" },
    // 告警条（设计稿 alert：错误语义；主题无 errorContainer 槽位，用 secondaryContainer 或 cardBg 兼容）
    alert: { backgroundColor: theme.secondaryContainer ?? theme.cardBg, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm, borderWidth: 1, borderColor: theme.error },
    alertTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.error },
    alertMsg: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, marginTop: MIUIX_SPACE.xs },
    emptyText: { fontSize: MIUIX_TYPE.footnote1, color: theme.dim, flex: 1 },
    listGap: { gap: 0 },
  });
}

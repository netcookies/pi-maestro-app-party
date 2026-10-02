/**
 * Dashboard 工作台 — 态势总览首页（方向 A）
 *
 * 布局（对齐 miuix-prototype/design-demos/redesign-a-command-overview.html）：
 * 顶部 Hero（Token 用量卡：无协议数据源，显示 -- 并注明待 Host 接入），
 * 2x2 指标卡，现在运行窗口列表，「需要关注」告警区。
 *
 * 数据全部来自 store（Protocol v2 workspace/execution projections / session error / Ask / Plan），

 * 指标推导集中在 src/dashboard-logic.ts（纯函数，可单测）。
 */
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useHost } from "../../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, hexToRgba } from "../../src/theme";
import { LineIcon } from "../../src/components/LineIcon";
import { SpringCard } from "../../src/components/SpringCard";
import { PulsingDot } from "../../src/components/PulsingDot";
import { useTabSwipe } from "../../src/hooks/useTabSwipe";
import { useI18n } from "../../src/i18n";
import {
  aggregateSessionUsage,
  deriveDashboardMetrics,
  getActiveUsageTargets,
  selectMissingUsageTargets,
  getCacheHitPercent,
  type PendingAskItem,
} from "../../src/dashboard-logic";
import { sessionTargetKey, type SessionExecutionSummary, type SessionUsageSummary, type MonitorWindowSummary } from "@maestro-mobile/shared";

/** 2x2 指标卡定义 */
type MetricCard = { value: string; label: string };

/** 用量数值格式化：token 数缩写（k），1 位小数；0 显示 0 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export default function DashboardScreen({ active = true }: { active?: boolean }) {
  const router = useRouter();
  const { state, isConnected, connectionState, fetchSessionUsage, loadSessionHistory, cancelDialog, cancelPlan } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const [currentAskIndex, setCurrentAskIndex] = useState(0);
  const [openingAsk, setOpeningAsk] = useState(false);
  const [currentPlanIndex, setCurrentPlanIndex] = useState(0);
  const [openingPlan, setOpeningPlan] = useState(false);

  // Dashboard deliberately contains overview, Ask/Plan attention, and connection state only.

  /** 只聚合会话 Tab Current 集合中的 exact-target usage。 */
  const [usage, setUsage] = React.useState<SessionUsageSummary | null>(null);
  const usageTargets = useMemo(
    () => getActiveUsageTargets([...state.sessions.values()], state.activeSessionTargets.entries()),
    [state.activeSessionTargets, state.sessions],
  );
  const listedUsageByTarget = useMemo(() => new Map(
    usageTargets.flatMap(({ targetKey }) => {
      const summary = state.hostSessionUsage.get(targetKey);
      return summary?.entries ? [[targetKey, summary] as const] : [];
    }),
  ), [state.hostSessionUsage, usageTargets]);
  React.useEffect(() => {
    let cancelled = false;
    setUsage(aggregateSessionUsage([...listedUsageByTarget.values()]));
    const missingUsageTargets = selectMissingUsageTargets(usageTargets, listedUsageByTarget);
    if (!active || !isConnected || missingUsageTargets.length === 0) return () => { cancelled = true; };

    void Promise.all(missingUsageTargets.map(async ({ sessionId, targetKey }) => ({
      targetKey,
      summary: await fetchSessionUsage(sessionId),
    }))).then((results) => {
      if (cancelled) return;
      const usageByTarget = new Map(listedUsageByTarget);
      for (const { targetKey, summary } of results) {
        if (summary?.entries) usageByTarget.set(targetKey, summary);
      }
      setUsage(aggregateSessionUsage([...usageByTarget.values()]));
    });
    return () => { cancelled = true; };
  }, [active, fetchSessionUsage, isConnected, listedUsageByTarget, usageTargets]);

  const pairingPrompt = connectionState === "connecting"
    ? t.connectingHost
    : connectionState === "reconnecting"
      ? t.reconnectingHost
      : t.goToPair;
  const canOpenPairing = connectionState === "disconnected";

  // 待处理 ask 弹窗投影（聚合 extension-ui 队列 pending 项，以及来自 monitor windows 的交互等待）
  const pendingAsks = React.useMemo<PendingAskItem[]>(() => {
    const list: PendingAskItem[] = state.dialogs
      .filter((d) => d.status === "pending")
      .map((d) => ({
        requestId: d.request.id,
        sessionId: d.request.sessionId,
        ...(d.target ? { target: d.target } : {}),
        method: d.request.method,
        title: d.request.title,
        message: d.request.message,
      }));

    return list;
  }, [state.dialogs]);

  const pendingPlans = React.useMemo(() => state.planRequests.filter((entry) => entry.status === "pending"), [state.planRequests]);

  const workspaceWindows = useMemo(
    () => {
      const windows = new Map<string, MonitorWindowSummary>();
      for (const projection of state.workspaceWindowProjections.values()) {
        for (const window of projection.data.windows) {
          if (window.presentation?.visibility !== "monitor_tab") continue;
          const key = sessionTargetKey({
            sessionId: window.sessionId,
            endpointId: window.endpointId,
            normalizedCwd: window.cwd ?? "",
            processGeneration: window.identity.ownerNonce || window.identity.ownerId,
          });
          windows.set(key, window);
        }
      }
      return [...windows.values()];
    },
    [state.workspaceWindowProjections],
  );
  const executionSummaryList = useMemo(() => {
    const summaries = [...state.sessionExecutionSummaries.values()];
    const activeTargetKeys = new Set(state.activeSessionTargets.values());
    return activeTargetKeys.size > 0
      ? summaries.filter((summary) => activeTargetKeys.has(sessionTargetKey(summary.target)))
      : summaries;
  }, [state.activeSessionTargets, state.sessionExecutionSummaries]);
  const executionSummaries = useMemo<SessionExecutionSummary[] | undefined>(
    () => executionSummaryList.length > 0 ? executionSummaryList : undefined,
    [executionSummaryList],
  );
  const sessionErrors = useMemo(
    () => [...state.sessionAlerts].map(([key, error]) => {
      const summary = state.sessionExecutionSummaries.get(key);
      return {
        key,
        windowName: summary?.workspace?.label ?? summary?.target.sessionId ?? key,
        code: error.code,
        message: error.message,
      };
    }),
    [state.sessionAlerts, state.sessionExecutionSummaries],
  );

  const sessionListSessions = useMemo(
    () => [...state.sessions.values()].filter((session) => session.presentation?.visibility === "session_list"),
    [state.sessions],
  );
  const sessionWindowCounts = useMemo(() => {
    const sessionIds = new Set(sessionListSessions.map((session) => session.id));
    const active = [...state.activeSessionTargets.entries()].filter(
      ([sessionId, targetKey]) => sessionIds.has(sessionId) && !targetKey.includes('"history"'),
    ).length;
    return { active, total: sessionIds.size };
  }, [sessionListSessions, state.activeSessionTargets]);

  const metrics = React.useMemo(
    () => deriveDashboardMetrics({
      monitor: workspaceWindows.length > 0 ? { windows: workspaceWindows, observedAt: new Date().toISOString() } : state.monitor,
      maestro: state.maestro,
      pendingAsks,
      pendingPlans: pendingPlans.length,
      executionSummaries,
      sessions: sessionListSessions,
      sessionWindowCounts,
      sessionErrors,
    }, new Date()),
    [executionSummaries, pendingAsks, pendingPlans.length, sessionErrors, sessionListSessions, sessionWindowCounts, state.maestro, state.monitor, workspaceWindows],
  );

  const metricCards = React.useMemo<MetricCard[]>(() => [
    {
      value: String(metrics.activeWindows),
      label: t.tabWorkbench === "工作台"
        ? `活跃窗口 / 共 ${metrics.totalWindows}`
        : `Active / Total ${metrics.totalWindows}`,
    },
    {
      value: metrics.totalTasks === null ? "--" : `${metrics.completedTasks} / ${metrics.totalTasks}`,
      label: t.tabWorkbench === "工作台"
        ? "任务完成 / 总任务"
        : "Tasks Completed / Total",
    },
    {
      value: `${metrics.activeSessionsToday} / ${metrics.totalSessions}`,
      label: t.tabWorkbench === "工作台"
        ? "今日活跃会话 / 会话总数"
        : "Active Today / Total Sessions",
    },
    {
      value: String(metrics.waitingCount),
      label: t.tabWorkbench === "工作台"
        ? "等待处理"
        : "Pending Actions",
    },
  ], [metrics, t]);

  const renderAttentionGroup = ({ item }: { item: { key: string; windowName: string; items: { code: string; severity: string; message: string }[] } }) => (
    <View style={styles.alert}>
      <Text style={styles.alertTitle}>{item.windowName} · {item.items.length} {t.alertCount}</Text>
      {item.items.slice(0, 3).map((a, i) => (
        <Text key={i} style={styles.alertMsg} numberOfLines={1}>· {a.message}</Text>
      ))}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* 统一定制顶栏：顶部状态栏背景与 Header 融为一体，只有下方微阴影 */}
      <View style={[styles.headerContainer, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
          <View style={styles.topHeader}>
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
              <PulsingDot color={isConnected ? theme.success : theme.error} size={6} active={isConnected} />
              <Text style={[styles.topHeaderOnlineText, { color: isConnected ? theme.success : theme.error }]}>
                {isConnected ? t.onlineBadge : t.offlineBadge}
              </Text>
            </View>
          </View>
        </SafeAreaView>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Hero：会话 Tab Current 集合的 Token usage 总和；点击进入会话页。 */}
        <SpringCard
          style={styles.hero}
          onPress={() => router.push(isConnected ? "/host-sessions" : "/settings")}
          accessibilityRole="button"
          accessibilityLabel={isConnected ? t.openSessionHint : pairingPrompt}
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
              <PulsingDot color={isConnected ? theme.success : theme.error} size={6} active={isConnected} />
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
                <Text style={[styles.heroCaption, { color: theme.accent, fontWeight: "700" }]}>
                  {t.cacheTokensLabel} {formatTokens(usage.cacheRead + usage.cacheWrite)}{getCacheHitPercent(usage) === null ? "" : ` (${getCacheHitPercent(usage)}%)`}
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 12 }}>
                <Text style={styles.heroValue}>--</Text>
                <Text style={{ fontSize: 12, color: theme.dim, fontFamily: "monospace" }}>tokens</Text>
              </View>
              <Text style={[styles.heroCaption, { color: theme.muted }]}>
                {isConnected ? t.openSessionHint : pairingPrompt}
              </Text>
            </>
          )}
        </SpringCard>
        <View style={styles.grid}>
          {metricCards.map((c, i) => {
            // 第3项(Teammate)工坊紫高亮，第4项(Ask)琥珀橙高亮
            const highlightColor = i === 2 ? theme.accent : i === 3 ? theme.warning : theme.text;
            const targetRoute = i === 2 || i === 3 ? "/monitor" : "/host-sessions";
            return (
              <SpringCard
                key={c.label}
                style={styles.metric}
                onPress={() => router.push(targetRoute as any)}
                accessibilityRole="button"
                accessibilityLabel={`${c.label}: ${c.value}`}
              >
                <Text style={[styles.metricValue, { color: highlightColor }]}>{c.value}</Text>
                <Text style={styles.metricLabel}>{c.label}</Text>
              </SpringCard>
            );
          })}
        </View>

        {/* 系统警告 */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t.attentionTitle}</Text>
          <Text style={styles.sectionMeta}>{metrics.waitingAttention} {t.alertCount}</Text>
        </View>
        {metrics.attentionGroups.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.emptyText}>{t.noAlerts}</Text>
          </View>
        ) : (
          metrics.attentionGroups.map((group) => <View key={group.key}>{renderAttentionGroup({ item: group })}</View>)
        )}
        {/* 待处理 Ask 弹窗卡片（支持多条队列角标与前后切换） */}
        {pendingAsks.length > 0 && pendingAsks[currentAskIndex] && (
          <TouchableOpacity
            activeOpacity={0.92}
            onPress={() => {
              const ask = pendingAsks[currentAskIndex];
              if (!ask?.target) return;
              const targetKey = sessionTargetKey(ask.target);
              router.push({ pathname: "/session", params: { id: ask.sessionId, targetKey } });
            }}
            style={[styles.askCard, { backgroundColor: theme.secondaryContainer ?? theme.cardBg, borderColor: theme.warning }]}
          >
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
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setCurrentAskIndex((prev) => (prev > 0 ? prev - 1 : pendingAsks.length - 1));
                      }}
                      style={[styles.askNavBtn, { backgroundColor: theme.inputBg }]}
                    >
                      <Text style={[styles.askNavBtnText, { color: theme.text }]}>‹</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={(e) => {
                        e.stopPropagation?.();
                        setCurrentAskIndex((prev) => (prev < pendingAsks.length - 1 ? prev + 1 : 0));
                      }}
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
                style={[styles.askApproveBtn, { backgroundColor: theme.buttonPrimary }, openingAsk && { opacity: 0.7 }]}
                disabled={openingAsk}
                onPress={async (e) => {
                  e.stopPropagation?.();
                  const targetAsk = pendingAsks[currentAskIndex];
                  if (targetAsk) {
                    setOpeningAsk(true);
                    try {
                      const targetKey = targetAsk.target ? sessionTargetKey(targetAsk.target) : undefined;
                      if (!targetKey) return;
                      await loadSessionHistory(targetAsk.sessionId, targetKey);
                      router.push({ pathname: "/session", params: { id: targetAsk.sessionId, targetKey } });
                    } catch {
                      // 不携带 exact target 时禁止回退到可能相同 sessionId 的 sibling。
                    } finally {
                      setOpeningAsk(false);
                    }
                  }
                }}
              >
                <Text style={styles.askBtnText}>{openingAsk ? "加载中…" : "查看会话与作答"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.askRejectBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]}
                onPress={(e) => {
                  e.stopPropagation?.();
                  void cancelDialog(pendingAsks[currentAskIndex].requestId);
                  if (currentAskIndex >= pendingAsks.length - 1 && currentAskIndex > 0) {
                    setCurrentAskIndex(currentAskIndex - 1);
                  }
                }}
              >
                <Text style={[styles.askBtnText, { color: theme.muted }]}>忽略</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        )}

        {/* 待处理 Plan 卡片：携带完整 target key，避免同 sessionId 的 sibling 误路由 */}
        {pendingPlans.length > 0 && pendingPlans[currentPlanIndex] && (
          <TouchableOpacity
            activeOpacity={0.92}
            onPress={() => {
              const entry = pendingPlans[currentPlanIndex];
              if (entry) router.push({ pathname: "/session", params: { id: entry.sessionId, targetKey: sessionTargetKey(entry.target) } });
            }}
            style={[styles.askCard, { backgroundColor: theme.secondaryContainer ?? theme.cardBg, borderColor: theme.accent }]}
            accessibilityRole="button"
            accessibilityLabel={`待处理计划 ${currentPlanIndex + 1} / ${pendingPlans.length}`}
          >
            <View style={styles.askHeader}>
              <View style={styles.askTitleWrap}>
                <LineIcon name="bolt" size={16} color={theme.accent} />
                <Text style={[styles.askTitle, { color: theme.accent }]}>待处理计划</Text>
              </View>
              <View style={styles.askCounterWrap}>
                <Text style={[styles.askCounterText, { color: theme.accent }]}>{currentPlanIndex + 1} / {pendingPlans.length}</Text>
                {pendingPlans.length > 1 && (
                  <View style={styles.askNavBtns}>
                    <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); setCurrentPlanIndex((index) => index > 0 ? index - 1 : pendingPlans.length - 1); }} style={[styles.askNavBtn, { backgroundColor: theme.inputBg }]}>
                      <Text style={[styles.askNavBtnText, { color: theme.text }]}>‹</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={(e) => { e.stopPropagation?.(); setCurrentPlanIndex((index) => index < pendingPlans.length - 1 ? index + 1 : 0); }} style={[styles.askNavBtn, { backgroundColor: theme.inputBg }]}>
                      <Text style={[styles.askNavBtnText, { color: theme.text }]}>›</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
            <Text style={styles.askMainTitle} numberOfLines={1}>{pendingPlans[currentPlanIndex].request.pathLabel} · {pendingPlans[currentPlanIndex].request.kind === "review" ? "审阅计划" : "确认计划"}</Text>
            <Text style={styles.askDescText} numberOfLines={2}>{pendingPlans[currentPlanIndex].request.markdown.slice(0, 220)}</Text>
            <View style={styles.askActionRow}>
              <TouchableOpacity
                style={[styles.askApproveBtn, { backgroundColor: theme.buttonPrimary }, openingPlan && { opacity: 0.7 }]}
                disabled={openingPlan}
                onPress={async (e) => {
                  e.stopPropagation?.();
                  const entry = pendingPlans[currentPlanIndex];
                  if (!entry) return;
                  setOpeningPlan(true);
                  const targetKey = sessionTargetKey(entry.target);
                  try {
                    await loadSessionHistory(entry.sessionId, targetKey);
                  } catch {
                    setOpeningPlan(false);
                    return;
                  }
                  router.push({ pathname: "/session", params: { id: entry.sessionId, targetKey } });
                  setOpeningPlan(false);
                }}
              >
                <Text style={styles.askBtnText}>{openingPlan ? "加载中…" : "查看并处理计划"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.askRejectBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]}
                onPress={(e) => { e.stopPropagation?.(); const entry = pendingPlans[currentPlanIndex]; if (entry) cancelPlan(entry.request.requestId, entry.target); }}
              >
                <Text style={[styles.askBtnText, { color: theme.muted }]}>取消</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
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

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
import React, { useCallback, useMemo } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
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
  const { state, isConnected, fetchMonitorState, fetchSessionUsage } = useHost();
  const { theme } = useTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);

  const windows = state.monitor?.windows ?? [];

  // 进入页面主动拉取一次（host 只在变化时推送，后连接会错过）
  React.useEffect(() => {
    void fetchMonitorState();
  }, [fetchMonitorState]);

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
    { value: String(metrics.activeWindows), label: `活跃窗口 / 共 ${metrics.totalWindows}` },
    { value: `${metrics.runsCompletedToday} / ${metrics.runsCompletedToday + metrics.runsActive}`, label: "今日 Run 完成 / 总数" },
    { value: `${metrics.teammatesWorking} / ${metrics.teammatesTotal}`, label: "Teammate 工作中 / 可见" },
    { value: String(metrics.waitingCount), label: "等待你处理（Ask + Attention）" },
  ], [metrics]);

  // 窗口行 key 提取（windowKey 与 dashboard-logic / monitor 共享）
  const keyExtractor = useCallback((w: MonitorWindowSummary) => windowKey(w), []);

  const renderWindowRow = useCallback(({ item }: { item: MonitorWindowSummary }) => {
    const statusColor = item.status === "running" ? theme.success : item.status === "sleeping" ? theme.warning : theme.muted;
    const agents = metrics.runningWindows.find((r) => r.key === windowKey(item));
    return (
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <View style={styles.rowMain}>
          <Text style={styles.rowTitle} numberOfLines={1}>{item.name ?? "未命名窗口"}</Text>
          <Text style={styles.rowDesc} numberOfLines={1}>
            {item.objective || item.status}
            {agents && agents.agentsTotal > 0 ? ` · ${agents.agentsRunning}/${agents.agentsTotal} teammates` : ""}
          </Text>
        </View>
      </View>
    );
  }, [theme, styles, metrics.runningWindows]);

  const renderAttentionGroup = useCallback(({ item }: { item: { key: string; windowName: string; items: { code: string; severity: string; message: string }[] } }) => (
    <View style={styles.alert}>
      <Text style={styles.alertTitle}>{item.windowName} · {item.items.length} 条告警</Text>
      {item.items.slice(0, 3).map((a, i) => (
        <Text key={i} style={styles.alertMsg} numberOfLines={1}>· {a.message}</Text>
      ))}
    </View>
  ), [styles]);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Hero：Token 用量卡（首个已打开会话的 usage；无打开会话时显示待接入提示） */}
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <Text style={styles.heroLabel}>当前会话用量</Text>
            <View style={styles.live}>
              <View style={[styles.liveDot, { backgroundColor: isConnected ? theme.success : theme.error }]} />
              <Text style={styles.liveText}>{isConnected ? "Host 在线" : "未连接"}</Text>
            </View>
          </View>
          {usage && usage.entries > 0 ? (
            <>
              <Text style={styles.heroValue}>{formatTokens(usage.totalTokens)}</Text>
              <Text style={styles.heroCaption}>
                Token · 输出 {formatTokens(usage.output)} · 成本 ${usage.cost.toFixed(4)}
                {usage.context?.percent != null ? ` · 上下文 ${Math.round(usage.context.percent)}%` : ""}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.heroValue}>--</Text>
              <Text style={styles.heroCaption}>{isConnected ? "在会话页打开一个会话后显示用量" : "连接 Host 后显示用量"}</Text>
            </>
          )}
        </View>

        {/* 2x2 指标卡 */}
        <View style={styles.grid}>
          {metricCards.map((c) => (
            <View key={c.label} style={styles.metric}>
              <Text style={styles.metricValue}>{c.value}</Text>
              <Text style={styles.metricLabel}>{c.label}</Text>
            </View>
          ))}
        </View>

        {/* 现在运行 */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>现在运行</Text>
          <TouchableOpacity onPress={() => router.push("/monitor")} accessibilityRole="button">
            <Text style={styles.linkText}>全部窗口</Text>
          </TouchableOpacity>
        </View>
        {windows.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.emptyText}>暂无窗口数据 · 等待 Host 推送</Text>
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
          <Text style={styles.sectionTitle}>需要关注</Text>
          <Text style={styles.sectionMeta}>{metrics.waitingCount} 条</Text>
        </View>
        {metrics.attentionGroups.length === 0 ? (
          <View style={styles.row}>
            <Text style={styles.emptyText}>暂无告警</Text>
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
    content: { padding: MIUIX_SPACE.lg, paddingBottom: MIUIX_SPACE.xxl },
    // Hero（设计稿 hero：深色卡 + 周期提示；暂无 usage 数据源，显示占位）
    hero: { backgroundColor: theme.text === "#000000" ? "#161719" : theme.mdCodeBlockBg, borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.lg, marginBottom: MIUIX_SPACE.md },
    heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    heroLabel: { fontSize: MIUIX_TYPE.body2, fontWeight: "700", color: theme.bg === "#FFFFFF" ? "#fff" : theme.text },
    heroValue: { fontSize: 36, fontWeight: "700", color: theme.bg === "#FFFFFF" ? "#fff" : theme.text, marginTop: MIUIX_SPACE.md, fontVariant: ["tabular-nums"] },
    heroCaption: { fontSize: MIUIX_TYPE.footnote1, color: theme.bg === "#FFFFFF" ? "#adb1ba" : theme.muted, marginTop: MIUIX_SPACE.xs },
    live: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.xs },
    liveDot: { width: 7, height: 7, borderRadius: MIUIX_RADIUS.pill },
    liveText: { fontSize: MIUIX_TYPE.footnote2, color: theme.bg === "#FFFFFF" ? "#adb1ba" : theme.muted },
    // 2x2 指标卡（设计稿 grid/metric）
    grid: { flexDirection: "row", flexWrap: "wrap", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.md },
    metric: { flexGrow: 1, flexBasis: "46%", backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.border, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md },
    metricValue: { fontSize: MIUIX_TYPE.title3, fontWeight: "700", color: theme.text, fontVariant: ["tabular-nums"] },
    metricLabel: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, marginTop: MIUIX_SPACE.xs },
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
    dot: { width: 9, height: 9, borderRadius: MIUIX_RADIUS.pill },
    // 告警条（设计稿 alert：错误语义；主题无 errorContainer 槽位，用 secondaryContainer 或 cardBg 兼容）
    alert: { backgroundColor: theme.secondaryContainer ?? theme.cardBg, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm, borderWidth: 1, borderColor: theme.error },
    alertTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.error },
    alertMsg: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, marginTop: MIUIX_SPACE.xs },
    emptyText: { fontSize: MIUIX_TYPE.footnote1, color: theme.dim, flex: 1 },
    listGap: { gap: 0 },
  });
}

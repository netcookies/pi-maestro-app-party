import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from "react-native";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import type { MonitorWindowSummary, MonitorAttentionSummary } from "@maestro-mobile/shared";

export default function MonitorScreen() {
  const { state } = useHost();
  const { theme } = useTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const windows = state.monitor?.windows ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const LIMIT = 5;
  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 顶部 Attention 汇总告警条（设计稿 attention-bar：errorContainer + 脉冲点）
  const attentionWindows = windows.filter((w) => w.attention.length > 0);
  const totalAttention = windows.reduce((n, w) => n + w.attention.length, 0);

  const renderWindow = ({ item }: { item: MonitorWindowSummary }) => {
    const key = `${item.identity.workspaceId}-${item.identity.ownerId}`;
    const attentionExpanded = expanded.has(`${key}-attention`);
    const todosExpanded = expanded.has(`${key}-todos`);
    const shownAttention = attentionExpanded ? item.attention : item.attention.slice(0, LIMIT);
    const shownTodos = todosExpanded ? item.todos : item.todos.slice(0, LIMIT);
    return (
    <View style={styles.window}>
      <View style={styles.windowHeader}>
        <Text style={styles.windowName}>{item.name ?? "未命名窗口"}</Text>
        <Text style={[styles.windowStatus, { color: statusColor(item.status, theme) }]}>{item.status}</Text>
      </View>
      {item.objective ? <Text style={styles.objective}>{item.objective}</Text> : null}
      <Text style={styles.meta}>
        lifecycle: {item.lifecycle} | work: {item.workStatus}
      </Text>

      {item.attention.length > 0 && (
        <View style={styles.attentionSection}>
          <Text style={styles.sectionTitle}>Attention</Text>
          {shownAttention.map((a, i) => (
            <View key={i} style={styles.attentionItem}>
              <Text style={[styles.attentionCode, { color: sevColor(a.severity, theme) }]}>{a.code}</Text>
              <Text style={styles.attentionMsg}>{a.message}</Text>
            </View>
          ))}
          {item.attention.length > LIMIT && (
            <TouchableOpacity
              style={styles.showAllButton}
              accessibilityRole="button"
              onPress={() => toggleExpanded(`${key}-attention`)}
            >
              <Text style={styles.showAllText}>
                {attentionExpanded ? "收起" : `查看全部 ${item.attention.length} 条`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {item.todos.length > 0 && (
        <View style={styles.todoSection}>
          <Text style={styles.sectionTitle}>Todo</Text>
          {shownTodos.map((t, i) => {
            const done = t.status === "completed";
            return (
              <View key={i} style={styles.todoLine}>
                <View style={[styles.todoCheck, done && { backgroundColor: theme.accent, borderColor: theme.accent }]}>
                  {done ? <View style={styles.todoCheckInner} /> : null}
                </View>
                <Text style={[styles.todoSubject, done && styles.todoDoneText]} numberOfLines={1}>
                  {t.subject}
                </Text>
                <Text style={styles.todoStatus}>{t.status}</Text>
              </View>
            );
          })}
          {item.todos.length > LIMIT && (
            <TouchableOpacity
              style={styles.showAllButton}
              accessibilityRole="button"
              onPress={() => toggleExpanded(`${key}-todos`)}
            >
              <Text style={styles.showAllText}>
                {todosExpanded ? "收起" : `查看全部 ${item.todos.length} 条`}
              </Text>
            </TouchableOpacity>
          )}
          {/* Todo 进度条（设计稿 progress-wrap） */}
          <View style={styles.progressWrap}>
            <Text style={styles.progressMeta}>Todo 进度</Text>
            <Text style={styles.progressMeta}>
              {item.todos.filter((t) => t.status === "completed").length} / {item.todos.length}
            </Text>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: theme.secondaryContainer ?? theme.border }]}>
            <View
              style={[
                styles.progressFill,
                { backgroundColor: theme.accent, width: `${Math.round((item.todos.filter((t) => t.status === "completed").length / Math.max(1, item.todos.length)) * 100)}%` },
              ]}
            />
          </View>
        </View>
      )}
    </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* 顶部 Attention 汇总告警条 */}
      {totalAttention > 0 && (
        <View style={[styles.attentionBar, { backgroundColor: theme.errorContainer ?? theme.error }]}>
          <View style={[styles.sevDot, { backgroundColor: theme.error }]} />
          <Text style={[styles.attentionText, { color: theme.onErrorContainer ?? theme.error }]} numberOfLines={2}>
            <Text style={styles.attentionBold}>需要关注</Text> · {totalAttention} 条告警，涉及 {attentionWindows.length} 个窗口
          </Text>
        </View>
      )}
      {windows.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>暂无窗口数据</Text>
          <Text style={styles.emptyDesc}>等待 Host 推送 monitor 状态</Text>
        </View>
      ) : (
        <FlatList
          data={windows}
          keyExtractor={(w) => `${w.identity.workspaceId}-${w.identity.ownerId}`}
          renderItem={renderWindow}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function statusColor(s: string, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (s) {
    case "running": case "active": return theme.success;
    case "sleeping": return theme.warning;
    case "failed": case "disconnected": return theme.error;
    default: return theme.muted;
  }
}

function sevColor(s: MonitorAttentionSummary["severity"], theme: ReturnType<typeof useTheme>["theme"]) {
  switch (s) {
    case "error": return theme.error;
    case "warning": return theme.warning;
    default: return theme.accent;
  }
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  list: { padding: MIUIX_SPACE.lg },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: MIUIX_SPACE.xxl },
  emptyText: { fontSize: MIUIX_TYPE.body1, color: theme.muted, fontWeight: "600" },
  emptyDesc: { fontSize: MIUIX_TYPE.footnote1, color: theme.dim, marginTop: MIUIX_SPACE.sm },
  window: {
    backgroundColor: theme.cardBg,
    borderRadius: MIUIX_RADIUS.lg,
    padding: MIUIX_SPACE.lg,
    marginBottom: MIUIX_SPACE.md,
    borderWidth: 1,
    borderColor: theme.border,
  },
  windowHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: MIUIX_SPACE.sm },
  windowName: { fontSize: MIUIX_TYPE.main, fontWeight: "600", color: theme.text, flex: 1 },
  windowStatus: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "700", letterSpacing: 0.4 },
  // Attention 告警条（设计稿 attention-bar）
  attentionBar: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.sm, marginHorizontal: MIUIX_SPACE.lg, marginBottom: MIUIX_SPACE.md, borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.md },
  sevDot: { width: 10, height: 10, borderRadius: 5 },
  attentionText: { flex: 1, fontSize: MIUIX_TYPE.footnote1, lineHeight: 18 },
  attentionBold: { fontWeight: "700" },
  objective: { fontSize: MIUIX_TYPE.body2, color: theme.muted, marginBottom: MIUIX_SPACE.xs },
  meta: { fontSize: MIUIX_TYPE.footnote2, color: theme.dim, marginBottom: MIUIX_SPACE.sm },
  sectionTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "700", color: theme.text, marginBottom: MIUIX_SPACE.sm, marginTop: MIUIX_SPACE.xs },
  attentionSection: { marginBottom: MIUIX_SPACE.sm },
  attentionItem: { flexDirection: "row", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.xs },
  attentionCode: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600" },
  attentionMsg: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, flex: 1 },
  todoSection: { marginTop: MIUIX_SPACE.sm },
  // Todo checkbox 细线轨道行（设计稿 todo-line）
  todoLine: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.sm + 3, paddingVertical: 6 },
  todoCheck: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: theme.outline ?? theme.border, alignItems: "center", justifyContent: "center" },
  todoCheckInner: { width: 8, height: 8, borderRadius: 2, backgroundColor: "#fff" },
  todoDoneText: { color: theme.muted, textDecorationLine: "line-through" },
  // 进度条（设计稿 progress-wrap）
  progressWrap: { flexDirection: "row", justifyContent: "space-between", marginTop: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.xs },
  progressMeta: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, fontVariant: ["tabular-nums"] },
  progressTrack: { height: 5, borderRadius: 2.5, overflow: "hidden" },
  progressFill: { height: 5, borderRadius: 2.5 },
  showAllButton: { marginTop: MIUIX_SPACE.xs, alignSelf: "flex-start" },
  showAllText: { fontSize: MIUIX_TYPE.footnote1, color: theme.accent },
});
}
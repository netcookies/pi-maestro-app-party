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
          {shownTodos.map((t, i) => (
            <View key={i} style={styles.todoItem}>
              <Text style={styles.todoId}>#{t.id}</Text>
              <Text style={styles.todoSubject}>{t.subject}</Text>
              <Text style={styles.todoStatus}>{t.status}</Text>
            </View>
          ))}
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
        </View>
      )}
    </View>
    );
  };

  return (
    <View style={styles.container}>
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
  emptyText: { fontSize: 16, color: theme.muted, fontWeight: "600" },
  emptyDesc: { fontSize: 13, color: theme.dim, marginTop: MIUIX_SPACE.sm },
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
  windowStatus: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
  objective: { fontSize: MIUIX_TYPE.body2, color: theme.muted, marginBottom: MIUIX_SPACE.xs },
  meta: { fontSize: MIUIX_TYPE.footnote2, color: theme.dim, marginBottom: MIUIX_SPACE.sm },
  sectionTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "700", color: theme.text, marginBottom: MIUIX_SPACE.sm, marginTop: MIUIX_SPACE.xs },
  attentionSection: { marginBottom: MIUIX_SPACE.sm },
  attentionItem: { flexDirection: "row", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.xs },
  attentionCode: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600" },
  attentionMsg: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, flex: 1 },
  todoSection: {},
  todoItem: { flexDirection: "row", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.xs },
  todoId: { fontSize: MIUIX_TYPE.footnote2, color: theme.dim },
  todoSubject: { fontSize: MIUIX_TYPE.footnote2, color: theme.text, flex: 1 },
  todoStatus: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted },
  showAllButton: { marginTop: MIUIX_SPACE.xs, alignSelf: "flex-start" },
  showAllText: { fontSize: MIUIX_TYPE.footnote1, color: theme.accent },
});
}
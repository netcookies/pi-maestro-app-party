import React from "react";
import { View, Text, StyleSheet, FlatList, ScrollView } from "react-native";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";
import type { MonitorWindowSummary, MonitorAttentionSummary } from "@maestro-mobile/shared";

export default function MonitorScreen() {
  const { state } = useHost();
  const { theme } = useTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const windows = state.monitor?.windows ?? [];

  const renderWindow = ({ item }: { item: MonitorWindowSummary }) => (
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
          {item.attention.map((a, i) => (
            <View key={i} style={styles.attentionItem}>
              <Text style={[styles.attentionCode, { color: sevColor(a.severity, theme) }]}>{a.code}</Text>
              <Text style={styles.attentionMsg}>{a.message}</Text>
            </View>
          ))}
        </View>
      )}

      {item.todos.length > 0 && (
        <View style={styles.todoSection}>
          <Text style={styles.sectionTitle}>Todo</Text>
          {item.todos.map((t, i) => (
            <View key={i} style={styles.todoItem}>
              <Text style={styles.todoId}>#{t.id}</Text>
              <Text style={styles.todoSubject}>{t.subject}</Text>
              <Text style={styles.todoStatus}>{t.status}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );

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
  list: { padding: 16 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  emptyText: { fontSize: 16, color: theme.muted, fontWeight: "600" },
  emptyDesc: { fontSize: 13, color: theme.dim, marginTop: 8 },
  window: {
    backgroundColor: theme.cardBg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  windowHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  windowName: { fontSize: 15, fontWeight: "600", color: theme.text, flex: 1 },
  windowStatus: { fontSize: 12, fontWeight: "600" },
  objective: { fontSize: 13, color: theme.muted, marginBottom: 4 },
  meta: { fontSize: 11, color: theme.dim, marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "600", color: theme.text, marginBottom: 6, marginTop: 4 },
  attentionSection: { marginBottom: 8 },
  attentionItem: { flexDirection: "row", gap: 6, marginBottom: 4 },
  attentionCode: { fontSize: 11, fontWeight: "600" },
  attentionMsg: { fontSize: 12, color: theme.muted, flex: 1 },
  todoSection: {},
  todoItem: { flexDirection: "row", gap: 8, marginBottom: 4 },
  todoId: { fontSize: 11, color: theme.dim },
  todoSubject: { fontSize: 12, color: theme.text, flex: 1 },
  todoStatus: { fontSize: 11, color: theme.muted },
});
}
import React from "react";
import { View, Text, StyleSheet, FlatList, ScrollView } from "react-native";
import { useHost } from "../src/store.js";
import type { MonitorWindowSummary, MonitorAttentionSummary } from "@maestro-mobile/shared";

export default function MonitorScreen() {
  const { state } = useHost();
  const windows = state.monitor?.windows ?? [];

  const renderWindow = ({ item }: { item: MonitorWindowSummary }) => (
    <View style={styles.window}>
      <View style={styles.windowHeader}>
        <Text style={styles.windowName}>{item.name ?? "未命名窗口"}</Text>
        <Text style={[styles.windowStatus, { color: statusColor(item.status) }]}>{item.status}</Text>
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
              <Text style={[styles.attentionCode, { color: sevColor(a.severity) }]}>{a.code}</Text>
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

function statusColor(s: string) {
  switch (s) {
    case "running": case "active": return "#3fb950";
    case "sleeping": return "#d29922";
    case "failed": case "disconnected": return "#f85149";
    default: return "#8b949e";
  }
}

function sevColor(s: MonitorAttentionSummary["severity"]) {
  switch (s) {
    case "error": return "#f85149";
    case "warning": return "#d29922";
    default: return "#58a6ff";
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117" },
  list: { padding: 16 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  emptyText: { fontSize: 16, color: "#8b949e", fontWeight: "600" },
  emptyDesc: { fontSize: 13, color: "#484f58", marginTop: 8 },
  window: {
    backgroundColor: "#161b22",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#21262d",
  },
  windowHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  windowName: { fontSize: 15, fontWeight: "600", color: "#e6edf3", flex: 1 },
  windowStatus: { fontSize: 12, fontWeight: "600" },
  objective: { fontSize: 13, color: "#8b949e", marginBottom: 4 },
  meta: { fontSize: 11, color: "#484f58", marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "600", color: "#e6edf3", marginBottom: 6, marginTop: 4 },
  attentionSection: { marginBottom: 8 },
  attentionItem: { flexDirection: "row", gap: 6, marginBottom: 4 },
  attentionCode: { fontSize: 11, fontWeight: "600" },
  attentionMsg: { fontSize: 12, color: "#8b949e", flex: 1 },
  todoSection: {},
  todoItem: { flexDirection: "row", gap: 8, marginBottom: 4 },
  todoId: { fontSize: 11, color: "#484f58" },
  todoSubject: { fontSize: 12, color: "#e6edf3", flex: 1 },
  todoStatus: { fontSize: 11, color: "#8b949e" },
});
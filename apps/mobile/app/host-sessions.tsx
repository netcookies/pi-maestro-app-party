import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import type { HostSessionSummary } from "@maestro-mobile/shared";

export default function HostSessionsScreen() {
  const router = useRouter();
  const { listHostSessions, openExistingSession, loadSessionHistory } = useHost();
  const [sessions, setSessions] = useState<HostSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listHostSessions();
      setSessions(list.sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [listHostSessions]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleOpen = async (s: HostSessionSummary) => {
    if (opening) return;
    setOpening(s.id);
    try {
      const sessionId = await openExistingSession(s.path, s.cwd);
      // 拉取历史 timeline（回放）
      await loadSessionHistory(sessionId);
      router.push({ pathname: "/session", params: { id: sessionId } });
    } catch (e) {
      Alert.alert("打开失败", e instanceof Error ? e.message : "未知错误");
    } finally {
      setOpening(null);
    }
  };

  // 按项目分组
  const grouped = sessions.reduce<Record<string, HostSessionSummary[]>>((acc, s) => {
    (acc[s.cwd] ??= []).push(s);
    return acc;
  }, {});

  const rows = Object.entries(grouped).sort((a, b) => {
    const tA = Math.max(...a[1].map((s) => new Date(s.updatedAt).getTime()));
    const tB = Math.max(...b[1].map((s) => new Date(s.updatedAt).getTime()));
    return tB - tA;
  });

  const renderSession = ({ item }: { item: HostSessionSummary }) => (
    <TouchableOpacity
      style={styles.sessionItem}
      onPress={() => void handleOpen(item)}
      disabled={opening === item.id}
    >
      <View style={styles.sessionHeader}>
        <Text style={styles.sessionTitle}>
          {item.title || "(无首条消息)"}
        </Text>
        {opening === item.id && <ActivityIndicator size="small" color="#3fb950" />}
      </View>
      <View style={styles.sessionMeta}>
        <Text style={styles.sessionCount}>{item.messageCount} 条消息</Text>
        <Text style={styles.sessionTime}>{formatTime(item.updatedAt)}</Text>
      </View>
    </TouchableOpacity>
  );

  const renderGroup = ({ item }: { item: [string, HostSessionSummary[]] }) => {
    const [cwd, group] = item;
    return (
      <View style={styles.group}>
        <Text style={styles.groupTitle}>{cwdName(cwd)}</Text>
        <Text style={styles.groupPath}>{cwd}</Text>
        {group.map((s) => (
          <View key={s.id}>{renderSession({ item: s })}</View>
        ))}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3fb950" />
        <Text style={styles.centerText}>加载 Host 会话...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => void load()}>
          <Text style={styles.retryText}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarText}>{sessions.length} 个会话 / {rows.length} 个项目</Text>
        <TouchableOpacity onPress={() => void load()}>
          <Text style={styles.refreshText}>刷新</Text>
        </TouchableOpacity>
      </View>
      {sessions.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.centerText}>Host 上没有已存在的会话</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r[0]}
          renderItem={renderGroup}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function cwdName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.pop() ?? cwd;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  centerText: { color: "#8b949e", fontSize: 14, marginTop: 12 },
  errorText: { color: "#f85149", fontSize: 14 },
  retryButton: {
    marginTop: 12,
    backgroundColor: "#238636",
    paddingHorizontal: 24,
    paddingVertical: 8,
    borderRadius: 8,
  },
  retryText: { color: "#fff", fontWeight: "600" },
  toolbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 10,
    backgroundColor: "#161b22",
    borderBottomWidth: 1,
    borderBottomColor: "#21262d",
  },
  toolbarText: { color: "#8b949e", fontSize: 13 },
  refreshText: { color: "#58a6ff", fontSize: 14, fontWeight: "600" },
  list: { padding: 12 },
  group: { marginBottom: 16 },
  groupTitle: { color: "#e6edf3", fontSize: 15, fontWeight: "700" },
  groupPath: { color: "#484f58", fontSize: 11, marginBottom: 8 },
  sessionItem: {
    backgroundColor: "#161b22",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#21262d",
  },
  sessionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sessionTitle: { color: "#e6edf3", fontSize: 14, fontWeight: "600", flex: 1, marginRight: 8 },
  sessionMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  sessionCount: { color: "#8b949e", fontSize: 12 },
  sessionTime: { color: "#484f58", fontSize: 12 },
});
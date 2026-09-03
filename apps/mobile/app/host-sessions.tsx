import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";
import { getConfig } from "../src/config";
import type { HostSessionSummary, LiveSessionInfo } from "@maestro-mobile/shared";

type TabKey = "all" | "active" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "活跃" },
  { key: "history", label: "历史" },
];

export default function HostSessionsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { listHostSessions, listLiveSessions, openExistingSession, loadSessionHistory } = useHost();
  const cfg = getConfig();
  const [sessions, setSessions] = useState<HostSessionSummary[]>([]);
  const [liveSessions, setLiveSessions] = useState<Map<string, LiveSessionInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [query, setQuery] = useState("");

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

  const loadLive = useCallback(async () => {
    try {
      const list = await listLiveSessions();
      const m = new Map<string, LiveSessionInfo>();
      for (const s of list.sessions) {
        if (s.live) m.set(s.sessionId, s);
      }
      setLiveSessions(m);
    } catch {
      // 轮询失败静默
    }
  }, [listLiveSessions]);

  useEffect(() => {
    void load();
    void loadLive();
    // 每 5 秒刷新活跃状态（vibe coding 感知）
    const timer = setInterval(() => void loadLive(), cfg.livePollIntervalMs);
    return () => clearInterval(timer);
  }, [load, loadLive]);

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

  // 过滤：Tab + 搜索
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      // Tab 过滤
      if (tab === "active" && !liveSessions.has(s.id)) return false;
      if (tab === "history" && liveSessions.has(s.id)) return false;
      // 搜索：标题/id/cwd/模型/名称
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q)
        || s.id.toLowerCase().includes(q)
        || s.cwd.toLowerCase().includes(q)
        || (s.model ?? "").toLowerCase().includes(q)
        || (s.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [sessions, tab, query, liveSessions]);

  // 按项目分组
  const rows = useMemo(() => {
    const grouped = filtered.reduce<Record<string, HostSessionSummary[]>>((acc, s) => {
      (acc[s.cwd] ??= []).push(s);
      return acc;
    }, {});
    return Object.entries(grouped).sort((a, b) => {
      const tA = Math.max(...a[1].map((s) => new Date(s.updatedAt).getTime()));
      const tB = Math.max(...b[1].map((s) => new Date(s.updatedAt).getTime()));
      return tB - tA;
    });
  }, [filtered]);

  const renderSession = ({ item }: { item: HostSessionSummary }) => {
    const live = liveSessions.has(item.id);
    return (
      <TouchableOpacity
        style={[styles.sessionItem, live && styles.sessionItemLive]}
        onPress={() => void handleOpen(item)}
        disabled={opening === item.id}
      >
        <View style={styles.sessionHeader}>
          {live && <View style={styles.liveDot} />}
          <Text style={styles.sessionTitle} numberOfLines={2}>
            {item.name ?? item.title ?? "(无首条消息)"}
          </Text>
          {opening === item.id && <ActivityIndicator size="small" color={theme.success} />}
        </View>
        {/* 详情行：模型 / 消息数 / 时间 */}
        <View style={styles.detailRow}>
          {item.model ? (
            <Text style={styles.detailItem}>🧠 {item.model}</Text>
          ) : null}
          <Text style={styles.detailItem}>💬 {item.messageCount}</Text>
          <Text style={styles.detailItem}>{live ? "🟢 运行中" : formatTime(item.updatedAt)}</Text>
        </View>
        {/* 详情行：会话 id */}
        <Text style={styles.sessionId} numberOfLines={1}>
          #{item.id.slice(0, 12)} · {cwdName(item.cwd)}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderGroup = ({ item }: { item: [string, HostSessionSummary[]] }) => {
    const [cwd, group] = item;
    return (
      <View style={styles.group}>
        <Text style={styles.groupTitle}>{cwdName(cwd)}</Text>
        <Text style={styles.groupPath} numberOfLines={1}>{cwd}</Text>
        {group.map((s) => (
          <View key={s.id}>{renderSession({ item: s })}</View>
        ))}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.success} />
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

  const liveCount = sessions.filter((s) => liveSessions.has(s.id)).length;

  return (
    <View style={styles.container}>
      {/* Tab 栏 */}
      <View style={styles.tabBar}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tabItem, active && { borderBottomColor: theme.accent, borderBottomWidth: 2 }]}
              onPress={() => setTab(t.key)}
            >
              <Text style={[styles.tabText, { color: active ? theme.accent : theme.muted }]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
        <View style={styles.tabRight}>
          <Text style={styles.toolbarText}>
            {filtered.length} 个{tabsuffix(tab)}
            {liveCount > 0 ? ` · 🟢 ${liveCount}` : ""}
          </Text>
        </View>
      </View>

      {/* 搜索框 + 刷新 */}
      <View style={styles.searchRow}>
        <TextInput
          style={[styles.searchInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
          value={query}
          onChangeText={setQuery}
          placeholder="搜索标题 / ID / 模型 / 路径..."
          placeholderTextColor={theme.dim}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity onPress={() => { void load(); void loadLive(); }} style={styles.refreshBtn}>
          <Text style={[styles.refreshText, { color: theme.accent }]}>刷新</Text>
        </TouchableOpacity>
      </View>

      {filtered.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.centerText}>没有匹配的会话</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r[0]}
          renderItem={renderGroup}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

function tabsuffix(tab: TabKey): string {
  return tab === "all" ? "" : tab === "active" ? "活跃会话" : "历史会话";
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

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
    centerText: { color: theme.muted, fontSize: 14, marginTop: 12 },
    errorText: { color: theme.error, fontSize: 14 },
    retryButton: {
      marginTop: 12,
      backgroundColor: theme.buttonPrimary,
      paddingHorizontal: 24,
      paddingVertical: 8,
      borderRadius: 8,
    },
    retryText: { color: "#fff", fontWeight: "600" },
    tabBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12 },
    tabItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabText: { fontSize: 15, fontWeight: "600" },
    tabRight: { flex: 1, alignItems: "flex-end", paddingRight: 4 },
    toolbarText: { color: theme.muted, fontSize: 12 },
    searchRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
    searchInput: {
      flex: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      fontSize: 14,
    },
    refreshBtn: { paddingHorizontal: 8, paddingVertical: 6 },
    refreshText: { fontSize: 14, fontWeight: "600" },
    list: { padding: 12 },
    group: { marginBottom: 16 },
    groupTitle: { color: theme.text, fontSize: 15, fontWeight: "700" },
    groupPath: { color: theme.dim, fontSize: 11, marginBottom: 8 },
    sessionItem: {
      backgroundColor: theme.cardBg,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: theme.border,
    },
    sessionItemLive: { borderColor: theme.success, backgroundColor: theme.mdCodeBlockBg },
    sessionHeader: { flexDirection: "row", alignItems: "center" },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.success, marginRight: 6 },
    sessionTitle: { color: theme.text, fontSize: 14, fontWeight: "600", flex: 1, marginRight: 8 },
    detailRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
    detailItem: { color: theme.muted, fontSize: 12 },
    sessionId: { color: theme.dim, fontSize: 11, marginTop: 4 },
  });
}
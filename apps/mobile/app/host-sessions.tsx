import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import { getConfig, loadConfig } from "../src/config";
import type { HostSessionSummary, LiveSessionInfo } from "@maestro-mobile/shared";

type TabKey = "all" | "active" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "活跃" },
  { key: "history", label: "历史" },
];

// 扁平行模型：分组头与会话均为 FlatList 顶层行，保持列表虚拟化
type Row =
  | { type: "group"; key: string; cwd: string; count: number }
  | { type: "session"; key: string; session: HostSessionSummary; live: boolean; opening: boolean };

export default function HostSessionsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { listHostSessions, listLiveSessions, openExistingSession, loadSessionHistory } = useHost();
  const cfg = getConfig();

  // 确保配置加载（冷启动直接进本页时）
  useEffect(() => {
    void loadConfig();
  }, []);
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

  // 按项目分组并扁平化为一维行：分组头按最新会话时间排序，组内保持原序
  const flatRows = useMemo<Row[]>(() => {
    const grouped = filtered.reduce<Record<string, HostSessionSummary[]>>((acc, s) => {
      (acc[s.cwd] ??= []).push(s);
      return acc;
    }, {});
    const entries = Object.entries(grouped).sort((a, b) => {
      const tA = Math.max(...a[1].map((s) => new Date(s.updatedAt).getTime()));
      const tB = Math.max(...b[1].map((s) => new Date(s.updatedAt).getTime()));
      return tB - tA;
    });
    const rows: Row[] = [];
    for (const [cwd, group] of entries) {
      rows.push({
        type: "group",
        key: `g:${cwd}`,
        cwd,
        count: group.length,
      });
      for (const s of group) {
        rows.push({
          type: "session",
          key: `s:${s.id}`,
          session: s,
          live: liveSessions.has(s.id),
          opening: opening === s.id,
        });
      }
    }
    return rows;
  }, [filtered, liveSessions, opening]);

  const renderItem = ({ item }: { item: Row }) => {
    if (item.type === "group") {
      return (
        <View style={styles.group}>
          <Text style={styles.groupTitle}>
            {cwdName(item.cwd)} · {item.count}
          </Text>
          <Text style={styles.groupPath} numberOfLines={1}>{item.cwd}</Text>
        </View>
      );
    }
    const s = item.session;
    return (
      <TouchableOpacity
        style={[styles.sessionItem, item.live && styles.sessionItemLive]}
        onPress={() => void handleOpen(s)}
        disabled={item.opening}
        accessibilityRole="button"
      >
        <View style={styles.sessionHeader}>
          {item.live && <View style={styles.liveDot} />}
          <Text style={styles.sessionTitle} numberOfLines={2}>
            {s.name ?? s.title ?? "(无首条消息)"}
          </Text>
          {item.opening && <ActivityIndicator size="small" color={theme.success} />}
        </View>
        {/* 详情行：模型 / 消息数 / 时间 */}
        <View style={styles.detailRow}>
          {s.model ? (
            <Text style={styles.detailItem}>🧠 {s.model}</Text>
          ) : null}
          <Text style={styles.detailItem}>💬 {s.messageCount}</Text>
          <Text style={styles.detailItem}>{item.live ? "🟢 运行中" : formatTime(s.updatedAt)}</Text>
        </View>
        {/* 详情行：会话 id（仅超长时截断，保留中段可辦识） */}
        <Text style={styles.sessionId} numberOfLines={1} ellipsizeMode="middle">
          #{s.id.length > 14 ? s.id.slice(0, 6) + "…" + s.id.slice(-6) : s.id} · {cwdName(s.cwd)}
        </Text>
      </TouchableOpacity>
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

  const liveCount = filtered.filter((s) => liveSessions.has(s.id)).length;

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
          accessibilityLabel="搜索会话"
        />
        <TouchableOpacity
          onPress={() => { void load(); void loadLive(); }}
          style={styles.refreshBtn}
          accessibilityLabel="刷新列表"
        >
          <Text style={[styles.refreshText, { color: theme.accent }]}>刷新</Text>
        </TouchableOpacity>
      </View>

      {filtered.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.centerText}>没有匹配的会话</Text>
        </View>
      ) : (
        <FlatList
          data={flatRows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
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
    const t = d.getTime();
    if (!Number.isFinite(t)) return "时间未知";
    const now = new Date();
    const diff = now.getTime() - t;
    if (diff < 0) return d.toLocaleString();
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return d.toLocaleDateString();
  } catch {
    return "时间未知";
  }
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, justifyContent: "center", alignItems: "center", padding: MIUIX_SPACE.xxl },
    centerText: { color: theme.muted, fontSize: MIUIX_TYPE.body2, marginTop: MIUIX_SPACE.md },
    errorText: { color: theme.error, fontSize: MIUIX_TYPE.body2 },
    retryButton: {
      marginTop: MIUIX_SPACE.md,
      backgroundColor: theme.buttonPrimary,
      paddingHorizontal: MIUIX_SPACE.xxl,
      paddingVertical: MIUIX_SPACE.sm,
      borderRadius: MIUIX_RADIUS.md,
    },
    retryText: { color: "#fff", fontWeight: "600" },
    tabBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: MIUIX_SPACE.md },
    tabItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 2, borderBottomColor: "transparent" },
    tabText: { fontSize: MIUIX_TYPE.body1, fontWeight: "600" },
    tabRight: { flex: 1, alignItems: "flex-end", paddingRight: MIUIX_SPACE.xs },
    toolbarText: { color: theme.muted, fontSize: MIUIX_TYPE.footnote2 },
    searchRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: MIUIX_SPACE.md, paddingVertical: MIUIX_SPACE.sm, gap: MIUIX_SPACE.sm },
    searchInput: {
      flex: 1,
      borderRadius: MIUIX_RADIUS.sm,
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: MIUIX_SPACE.sm,
      borderWidth: 1,
      fontSize: MIUIX_TYPE.body2,
    },
    refreshBtn: { paddingHorizontal: MIUIX_SPACE.sm, paddingVertical: 6 },
    refreshText: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    list: { padding: MIUIX_SPACE.md },
    group: { marginBottom: MIUIX_SPACE.lg },
    groupTitle: { color: theme.text, fontSize: MIUIX_TYPE.main, fontWeight: "700" },
    groupPath: { color: theme.dim, fontSize: MIUIX_TYPE.footnote2, marginBottom: MIUIX_SPACE.sm },
    sessionItem: {
      backgroundColor: theme.cardBg,
      borderRadius: MIUIX_RADIUS.lg,
      padding: MIUIX_SPACE.md,
      marginBottom: MIUIX_SPACE.sm,
      borderWidth: 1,
      borderColor: theme.border,
    },
    sessionItemLive: { borderColor: theme.success, backgroundColor: theme.mdCodeBlockBg },
    sessionHeader: { flexDirection: "row", alignItems: "center" },
    liveDot: { width: 8, height: 8, borderRadius: MIUIX_RADIUS.xs, backgroundColor: theme.success, marginRight: 6 },
    sessionTitle: { color: theme.text, fontSize: MIUIX_TYPE.body2, fontWeight: "600", flex: 1, marginRight: MIUIX_SPACE.sm },
    detailRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
    detailItem: { color: theme.muted, fontSize: MIUIX_TYPE.footnote1 },
    sessionId: { color: theme.dim, fontSize: MIUIX_TYPE.footnote2, marginTop: MIUIX_SPACE.xs },
  });
}

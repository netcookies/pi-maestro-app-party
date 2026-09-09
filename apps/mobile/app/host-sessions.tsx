import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, TextInput,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import { getConfig, loadConfig } from "../src/config";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { HostConnectCard } from "../src/components/HostConnectCard";
import { HOST_CONN_KEY, importLegacyConnection } from "../src/paired-hosts";
import type { HostSessionSummary, LiveSessionInfo } from "@maestro-mobile/shared";
import { canLoadMoreSessions, isLoadMoreResponseCurrent, isTargetedResponseCurrent, mergeHostSessionPage, mergeTargetedHostSessions, shouldBlockSessionListError, shouldRequestTargetedSummaries, type TargetedCapability } from "../src/host-session-pagination";

const PAGE_SIZE = 30;

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
  const { listHostSessions, listLiveSessions, openExistingSession, closeSession, loadSessionHistory, isConnected, connectionState, lastError, hostUrl: connectedHostUrl, state: hostState } = useHost();
  // 当前已打开的会话（P2-4：open 新会话前先 close 旧的，避免 host 端旧 runner 泄漏）
  const openedSessionRef = useRef<string | null>(null);
  const cfg = getConfig();

  // 确保配置加载（冷启动直接进本页时）
  useEffect(() => {
    void loadConfig();
  }, []);
  const [sessions, setSessions] = useState<HostSessionSummary[]>([]);
  const sessionsRef = useRef<HostSessionSummary[]>([]);
  const [liveSessions, setLiveSessions] = useState<Map<string, LiveSessionInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | undefined>();
  const requestGenerationRef = useRef(0);
  const connectionEpochRef = useRef(0);
  const hostIdentityRef = useRef("");
  const targetedCapabilityRef = useRef<TargetedCapability>("unknown");
  const targetedInFlightRef = useRef(false);
  const targetedFailureCountRef = useRef(0);
  const targetedRetryAtRef = useRef(0);
  const firstPageInFlightRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const currentQueryRef = useRef("");
  const currentCursorRef = useRef<string | undefined>();
  const lastRequestedCursorRef = useRef<string | undefined>();
  const [opening, setOpening] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // 连接参数（原 index 页迁移；独立 AsyncStorage 键持久化）
  const [hostUrl, setHostUrl] = useState("ws://127.0.0.1:4739/ws");
  const [token, setToken] = useState("");

  useEffect(() => {
    connectionEpochRef.current += 1;
    hostIdentityRef.current = `${connectedHostUrl}|${connectionEpochRef.current}`;
    targetedCapabilityRef.current = "unknown";
    targetedInFlightRef.current = false;
    targetedFailureCountRef.current = 0;
    targetedRetryAtRef.current = 0;
    requestGenerationRef.current += 1;
  }, [connectedHostUrl, connectionState]);

  // 首次进入及从配对页返回时读回当前连接；Tab 页面不会保证 remount。
  useFocusEffect(useCallback(() => {
    let active = true;
    void (async () => {
      await importLegacyConnection();
      const raw = await AsyncStorage.getItem(HOST_CONN_KEY);
      if (!raw || !active) return;
      try {
        const saved = JSON.parse(raw) as { hostUrl?: string; token?: string };
        if (saved.hostUrl) setHostUrl(saved.hostUrl);
        setToken(saved.token ?? "");
      } catch {}
    })();
    return () => { active = false; };
  }, []));

  const handleHostUrlChange = (v: string) => {
    setHostUrl(v);
    void AsyncStorage.setItem(HOST_CONN_KEY, JSON.stringify({ hostUrl: v, token })).catch(() => {});
  };
  const handleTokenChange = (v: string) => {
    setToken(v);
    void AsyncStorage.setItem(HOST_CONN_KEY, JSON.stringify({ hostUrl, token: v })).catch(() => {});
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadFirstPage = useCallback(async (searchQuery: string, showRefresh = false) => {
    if (!isConnected) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const generation = ++requestGenerationRef.current;
    currentQueryRef.current = searchQuery;
    currentCursorRef.current = undefined;
    firstPageInFlightRef.current = true;
    lastRequestedCursorRef.current = undefined;
    loadingMoreRef.current = false;
    setNextCursor(undefined);
    setHasMore(false);
    setLoadingMore(false);
    setLoadMoreError(null);
    setError(null);
    setRefreshError(null);
    if (showRefresh || sessionsRef.current.length > 0) setRefreshing(true);
    else setLoading(true);
    try {
      const list = await listHostSessions({ limit: PAGE_SIZE, ...(searchQuery ? { query: searchQuery } : {}) });
      if (generation !== requestGenerationRef.current || searchQuery !== currentQueryRef.current) return;
      const page = mergeHostSessionPage([], list, true);
      sessionsRef.current = page.sessions;
      setSessions(page.sessions);
      setNextCursor(page.nextCursor);
      currentCursorRef.current = page.nextCursor;
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (e) {
      if (generation === requestGenerationRef.current) {
        const message = e instanceof Error ? e.message : "加载失败";
        if (shouldBlockSessionListError(sessionsRef.current.length)) setError(message);
        else setRefreshError(message);
      }
    } finally {
      if (generation === requestGenerationRef.current) {
        firstPageInFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [listHostSessions, isConnected]);

  const loadMore = useCallback(async () => {
    if (!canLoadMoreSessions({
      connected: isConnected,
      hasMore,
      nextCursor,
      loading: loadingMoreRef.current,
      lastRequestedCursor: lastRequestedCursorRef.current,
      firstPageInFlight: firstPageInFlightRef.current,
    })) return;
    const generation = requestGenerationRef.current;
    const queryAtRequest = currentQueryRef.current;
    const cursor = nextCursor!;
    loadingMoreRef.current = true;
    lastRequestedCursorRef.current = cursor;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const list = await listHostSessions({
        limit: PAGE_SIZE,
        cursor,
        ...(queryAtRequest ? { query: queryAtRequest } : {}),
      });
      if (!isLoadMoreResponseCurrent({
        expectedGeneration: generation,
        currentGeneration: requestGenerationRef.current,
        expectedQuery: queryAtRequest,
        currentQuery: currentQueryRef.current,
        expectedCursor: cursor,
        currentCursor: currentCursorRef.current,
      })) return;
      const page = mergeHostSessionPage(sessionsRef.current, list, false);
      sessionsRef.current = page.sessions;
      setSessions(page.sessions);
      setNextCursor(page.nextCursor);
      currentCursorRef.current = page.nextCursor;
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (e) {
      if (generation === requestGenerationRef.current) {
        setLoadMoreError(e instanceof Error ? e.message : "加载更多失败");
        // A manual retry may issue the same cursor again.
        lastRequestedCursorRef.current = undefined;
      }
    } finally {
      if (generation === requestGenerationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [isConnected, hasMore, nextCursor, listHostSessions]);

  const hydrateActiveSummaries = useCallback(async (sessionIds: string[], latestForCwds: string[]) => {
    const missingIds = sessionIds.filter((id) => !sessionsRef.current.some((session) => session.id === id)).slice(0, 100);
    const requestedCwds = latestForCwds.slice(0, 100);
    if (missingIds.length === 0 && requestedCwds.length === 0) return;
    if (!shouldRequestTargetedSummaries({
      capability: targetedCapabilityRef.current,
      inFlight: targetedInFlightRef.current,
      failureCount: targetedFailureCountRef.current,
      maxFailures: 2,
      retryAt: targetedRetryAtRef.current,
      now: Date.now(),
    })) return;
    const generation = requestGenerationRef.current;
    const hostIdentity = hostIdentityRef.current;
    targetedInFlightRef.current = true;
    try {
      const response = await listHostSessions({ sessionIds: missingIds, latestForCwds: requestedCwds });
      if (!isTargetedResponseCurrent({
        expectedGeneration: generation,
        currentGeneration: requestGenerationRef.current,
        expectedHostIdentity: hostIdentity,
        currentHostIdentity: hostIdentityRef.current,
        connected: isConnected,
      })) return;
      targetedCapabilityRef.current = response.targeted === true ? "supported" : "unsupported";
      if (response.targeted !== true) return;
      targetedFailureCountRef.current = 0;
      targetedRetryAtRef.current = 0;
      const queryAtResponse = currentQueryRef.current.toLocaleLowerCase();
      const targeted = queryAtResponse
        ? { ...response, sessions: response.sessions.filter((session) => [session.title, session.id, session.cwd, session.model, session.name].some((value) => value?.toLocaleLowerCase().includes(queryAtResponse))) }
        : response;
      const merged = mergeTargetedHostSessions({ sessions: sessionsRef.current, nextCursor: currentCursorRef.current, hasMore, total }, targeted);
      if (merged.sessions !== sessionsRef.current) {
        sessionsRef.current = merged.sessions;
        setSessions(merged.sessions);
      }
    } catch {
      if (hostIdentity === hostIdentityRef.current) {
        targetedFailureCountRef.current += 1;
        targetedRetryAtRef.current = Date.now() + 5_000 * (2 ** (targetedFailureCountRef.current - 1));
      }
      // 网络失败不代表 Host 不支持；仅做两次带退避的有限重试。
    } finally {
      if (hostIdentity === hostIdentityRef.current) targetedInFlightRef.current = false;
    }
  }, [hasMore, isConnected, listHostSessions, total]);

  const loadLive = useCallback(async () => {
    try {
      const list = await listLiveSessions();
      const m = new Map<string, LiveSessionInfo>();
      for (const s of list.sessions) {
        if (s.live) m.set(s.sessionId, s);
      }
      setLiveSessions(m);
      const runningCwds = (hostState.monitor?.windows ?? [])
        .filter((window) => window.status === "running" && window.cwd)
        .map((window) => window.cwd);
      await hydrateActiveSummaries([...m.keys()], runningCwds);
    } catch {
      // 轮询失败静默
    }
  }, [hydrateActiveSummaries, hostState.monitor, listLiveSessions]);

  useEffect(() => {
    void loadFirstPage(debouncedQuery);
  }, [loadFirstPage, debouncedQuery]);

  useEffect(() => {
    void loadLive();
    // 活跃状态独立轻量轮询，不重新请求历史页。
    const timer = setInterval(() => { if (isConnected) void loadLive(); }, cfg.livePollIntervalMs);
    return () => clearInterval(timer);
  }, [loadLive, isConnected, cfg.livePollIntervalMs]);

  const handleOpen = async (s: HostSessionSummary) => {
    if (opening) return;
    setOpening(s.id);
    try {
      const sessionId = await openExistingSession(s.path, s.cwd);
      // host 端同样有重复 open 先 dispose 旧的修复；这里显式 close 旧会话做双保险
      const previous = openedSessionRef.current;
      if (previous && previous !== sessionId) {
        void closeSession(previous);
      }
      openedSessionRef.current = sessionId;
      // 拉取历史 timeline（回放）
      await loadSessionHistory(sessionId);
      router.push({ pathname: "/session", params: { id: sessionId } });
    } catch (e) {
      Alert.alert("打开失败", e instanceof Error ? e.message : "未知错误");
    } finally {
      setOpening(null);
    }
  };

  // Monitor running 窗口按 cwd 归并：这些窗口的「最近会话」也算活跃（窗口 running 但 agent 空闲时
  // jsonl mtime 超过 live 阈值，纯 liveSessions 判定会漏掉 —— 用户在工作台/Monitor 看得到它却
  // 在活跃 tab 找不到）
  const runningWindowCwds = useMemo(() => {
    const set = new Set<string>();
    for (const w of hostState.monitor?.windows ?? []) {
      if (w.status === "running" && w.cwd) set.add(w.cwd);
    }
    return set;
  }, [hostState.monitor]);

  /** 每个 cwd 的最新会话 id（sessions 无全局排序保证，这里自行推导） */
  const latestPerCwd = useMemo(() => {
    const m = new Map<string, HostSessionSummary>();
    for (const s of sessions) {
      const cur = m.get(s.cwd);
      if (!cur || new Date(s.updatedAt).getTime() > new Date(cur.updatedAt).getTime()) m.set(s.cwd, s);
    }
    return m;
  }, [sessions]);

  const isSessionActive = useCallback((s: HostSessionSummary) =>
    liveSessions.has(s.id)
    || (runningWindowCwds.has(s.cwd) && latestPerCwd.get(s.cwd)?.id === s.id),
  [liveSessions, runningWindowCwds, latestPerCwd]);

  // Tab 只过滤已加载数据；文本搜索由 Host 对全库执行。
  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (tab === "active" && !isSessionActive(s)) return false;
      if (tab === "history" && isSessionActive(s)) return false;
      return true;
    });
  }, [sessions, tab, isSessionActive]);

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
            <Text style={styles.detailItem}>{s.model}</Text>
          ) : null}
          <Text style={styles.detailItem}>{s.messageCount} 条消息</Text>
          <Text style={styles.detailItem}>{item.live ? "运行中" : formatTime(s.updatedAt)}</Text>
        </View>
        {/* 详情行：会话 id（仅超长时截断，保留中段可辦识） */}
        <Text style={styles.sessionId} numberOfLines={1} ellipsizeMode="middle">
          #{s.id.length > 14 ? s.id.slice(0, 6) + "…" + s.id.slice(-6) : s.id} · {cwdName(s.cwd)}
        </Text>
      </TouchableOpacity>
    );
  };

  const liveCount = filtered.filter(isSessionActive).length;
  const loadedLabel = typeof total === "number"
    ? `已加载 ${sessions.length}/${total}`
    : `已加载 ${sessions.length}`;

  const listFooter = (
    <View style={styles.listFooter}>
      {loadingMore ? <ActivityIndicator size="small" color={theme.success} /> : null}
      {loadMoreError ? (
        <>
          <Text style={styles.loadMoreError}>{loadMoreError}</Text>
          <TouchableOpacity style={styles.loadMoreRetry} onPress={() => void loadMore()} accessibilityRole="button">
            <Text style={[styles.refreshText, { color: theme.accent }]}>重试加载更多</Text>
          </TouchableOpacity>
        </>
      ) : null}
      {!loadingMore && !loadMoreError ? <Text style={styles.loadedText}>{loadedLabel}</Text> : null}
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Host 控制中心连接卡（设计稿 screenSessions 对齐） */}
      <HostConnectCard
        hostUrl={hostUrl}
        token={token}
        onHostUrlChange={handleHostUrlChange}
        onTokenChange={handleTokenChange}
      />
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
            {liveCount > 0 ? ` · 运行中 ${liveCount}` : ""}
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
          onPress={() => { void loadFirstPage(debouncedQuery, true); void loadLive(); }}
          style={styles.refreshBtn}
          accessibilityLabel="刷新列表"
        >
          <Text style={[styles.refreshText, { color: theme.accent }]}>刷新</Text>
        </TouchableOpacity>
      </View>

      {refreshError && sessions.length > 0 ? (
        <View style={styles.inlineError}>
          <Text style={styles.errorText}>{refreshError}</Text>
        </View>
      ) : null}

      {error && sessions.length === 0 ? (
        <View style={styles.errorPanel}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => void loadFirstPage(debouncedQuery)}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : loading && sessions.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.success} />
          <Text style={styles.centerText}>加载 Host 会话...</Text>
        </View>
      ) : (
        <FlatList
          data={flatRows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshing={refreshing}
          onRefresh={() => void loadFirstPage(debouncedQuery, true)}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={<View style={styles.center}><Text style={styles.centerText}>没有匹配的会话</Text></View>}
          ListFooterComponent={sessions.length > 0 ? listFooter : null}
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
    inlineError: { paddingHorizontal: MIUIX_SPACE.md, paddingVertical: MIUIX_SPACE.xs },
    errorPanel: { alignItems: "center", padding: MIUIX_SPACE.xxl },
    errorText: { color: theme.error, fontSize: MIUIX_TYPE.body2, textAlign: "center" },
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
    listFooter: { minHeight: 56, alignItems: "center", justifyContent: "center", paddingVertical: MIUIX_SPACE.md },
    loadedText: { color: theme.dim, fontSize: MIUIX_TYPE.footnote2 },
    loadMoreError: { color: theme.error, fontSize: MIUIX_TYPE.footnote1, textAlign: "center" },
    loadMoreRetry: { paddingHorizontal: MIUIX_SPACE.md, paddingVertical: MIUIX_SPACE.sm },
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

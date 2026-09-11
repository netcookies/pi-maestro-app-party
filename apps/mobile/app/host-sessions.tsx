import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, Alert, TextInput,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, hexToRgba } from "../src/theme";
import { getConfig, loadConfig } from "../src/config";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { LineIcon } from "../src/components/LineIcon";
import { useI18n, formatRelativeTime } from "../src/i18n";
import type { HostSessionSummary, LiveSessionInfo } from "@maestro-mobile/shared";
import { canLoadMoreSessions, isLoadMoreResponseCurrent, isTargetedResponseCurrent, mergeHostSessionPage, mergeTargetedHostSessions, shouldBlockSessionListError, shouldRequestTargetedSummaries, type TargetedCapability } from "../src/host-session-pagination";

const PAGE_SIZE = 30;

type TabKey = "active" | "all";

// 扁平行模型：分组头与会话均为 FlatList 顶层行，保持列表虚拟化
type Row =
  | { type: "group"; key: string; cwd: string; count: number }
  | { type: "session"; key: string; session: HostSessionSummary; live: boolean; opening: boolean };

export default function HostSessionsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { listHostSessions, listLiveSessions, openExistingSession, closeSession, loadSessionHistory, fetchSessionUsage, isConnected, connectionState, lastError, hostUrl: connectedHostUrl, state: hostState } = useHost();
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
  const [usageMap, setUsageMap] = useState<Record<string, SessionUsageSummary>>({});
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
  const [tab, setTab] = useState<TabKey>("active");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchBarOpen, setSearchBarOpen] = useState(false);
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

  // 针对当前活跃会话异步拉取最新详细 usage
  useEffect(() => {
    if (!isConnected) return;
    const activeItems = sessions.filter(isSessionActive);
    for (const item of activeItems.slice(0, 5)) {
      if (!usageMap[item.id]) {
        void fetchSessionUsage(item.id).then((u) => {
          if (u) setUsageMap((prev) => ({ ...prev, [item.id]: u }));
        });
      }
    }
  }, [sessions, isConnected, fetchSessionUsage, isSessionActive, usageMap]);

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
        {/* 卡片顶行：状态指示点 + 标题 (主标题为文件夹名称) + 模型徽标 */}
        <View style={styles.sessionHeader}>
          <View style={styles.sessionHeaderLeft}>
            <View style={[styles.liveDotBase, item.live ? styles.liveDotActive : styles.liveDotIdle]} />
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {s.cwdName || (s.cwd ? s.cwd.replace(/\/$/, "").split("/").pop() : null) || s.name || s.title || "(未命名项目)"}
            </Text>
          </View>
          {s.model ? (
            <View style={styles.modelBadge}>
              <Text style={styles.modelBadgeText}>{s.model}</Text>
            </View>
          ) : null}
          {item.opening && <ActivityIndicator size="small" color={theme.accent} style={{ marginLeft: 6 }} />}
        </View>

        {/* 路径行 */}
        <View style={styles.pathRow}>
          <LineIcon name="folder" size={13} color={theme.muted} />
          <Text style={styles.pathText} numberOfLines={1}>{s.cwd || s.path}</Text>
        </View>

        {/* 2x2 Bento 便当盒仪表盘核心网格 */}
        <View style={styles.bentoGrid}>
          {/* 格 1：上下文视窗 (优先真实实时上下文，否则显示模型视窗上限) */}
          <View style={styles.bentoCell}>
            <Text style={styles.bentoCellLabel}>{t.contextLabel}</Text>
            {(() => {
              const liveUsage = usageMap[s.id];
              const context = s.context ?? liveUsage?.context;
              return (
                <Text style={[styles.bentoCellValue, context?.percent != null && { color: theme.accent }]}>
                  {(() => {
                    if (context) {
                      const pct = typeof context.percent === "number" ? Math.round(context.percent) : null;
                      const winK = context.contextWindow ? Math.round(context.contextWindow / 1000) : 200;
                      if (context.tokens != null && pct != null) {
                        const usedK = Math.round(context.tokens / 1000);
                        return `${usedK}k / ${winK}k (${pct}%)`;
                      }
                      if (pct != null) {
                        return `${pct}% (${winK}k)`;
                      }
                    }
                    if (!s.model) return "--";
                    const maxWindow = s.model.includes("gemini") ? "1000k" : s.model.includes("deepseek") ? "128k" : "200k";
                    return `${maxWindow} ${t.modelWindow}`;
                  })()}
                </Text>
              );
            })()}
          </View>

          {/* 格 2：Token 消耗 (有聚合数据时展示，否则安全展示 --) */}
          <View style={styles.bentoCell}>
            <Text style={styles.bentoCellLabel}>{t.tokensLabel}</Text>
            {(() => {
              const liveUsage = usageMap[s.id];
              const totalTokens = s.totalTokens ?? liveUsage?.totalTokens;
              const cost = s.cost ?? liveUsage?.cost;
              return (
                <Text style={styles.bentoCellValue}>
                  {typeof totalTokens === "number" && totalTokens > 0
                    ? `${(totalTokens / 1000).toFixed(1)}k ($${(cost ?? 0).toFixed(2)})`
                    : "--"}
                </Text>
              );
            })()}
          </View>

          {/* 格 3：状态 (双语化) */}
          <View style={styles.bentoCell}>
            <Text style={styles.bentoCellLabel}>{t.cacheLabel}</Text>
            <Text style={[styles.bentoCellValue, { color: item.live ? theme.success : theme.muted }]}>
              {item.live ? t.statusActive : t.readyLabel}
            </Text>
          </View>

          {/* 格 4：对话与时间 (条数与更新时间整合，100% 双语) */}
          <View style={styles.bentoCell}>
            <Text style={styles.bentoCellLabel}>{t.messagesAndTime}</Text>
            <Text style={styles.bentoCellValue}>
              {s.messageCount} {t.msgCount} · {formatRelativeTime(s.updatedAt, t)}
            </Text>
          </View>
        </View>

        {/* 上下文健康细条：100% 关联真实 context 消耗百分比 */}
        <View style={styles.contextTrack}>
          {(() => {
            const liveUsage = usageMap[s.id];
            const context = s.context ?? liveUsage?.context;
            const pct = typeof context?.percent === "number" ? Math.max(0, Math.min(100, Math.round(context.percent))) : 0;
            const barColor = pct > 90 ? theme.error : pct > 75 ? theme.warning : theme.accent;
            return (
              <View style={[styles.contextFill, { width: `${pct}%`, backgroundColor: barColor }]} />
            );
          })()}
        </View>
      </TouchableOpacity>
    );
  };

  const liveCount = filtered.filter(isSessionActive).length;
  const loadedLabel = typeof total === "number"
    ? (t.tabSessions === "会话" ? `已加载 ${sessions.length}/${total}` : `Loaded ${sessions.length}/${total}`)
    : (t.tabSessions === "会话" ? `已加载 ${sessions.length}` : `Loaded ${sessions.length}`);

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
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* 与原型精准一致的顶栏：顶部状态栏背景与 Header 融为一体，消除灰色断层 */}
      <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
        <View style={[styles.topHeader, { borderBottomColor: theme.border }]}>
          <View>
            <Text style={[styles.topHeaderTitle, { color: theme.text }]}>{t.tabSessions}</Text>
            <Text style={[styles.topHeaderSub, { color: theme.muted }]}>
              {connectedHostUrl ? (connectedHostUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "").split(":")[0]) : "100.98.197.10"} ({tab === "active" ? t.filterActive : t.filterAll})
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
            <View style={[styles.topHeaderGreenDot, { backgroundColor: isConnected ? theme.success : theme.error }]} />
            <Text style={[styles.topHeaderOnlineText, { color: isConnected ? theme.success : theme.error }]}>
              {isConnected ? t.onlineBadge : t.offlineBadge}
            </Text>
          </View>
        </View>
      </SafeAreaView>

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
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={styles.centerText}>加载会话列表中...</Text>
        </View>
      ) : (
        <FlatList
          data={flatRows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
          extraData={t}
          contentContainerStyle={[styles.list, { paddingBottom: 100 }]}
          keyboardShouldPersistTaps="handled"
          refreshing={refreshing}
          onRefresh={() => void loadFirstPage(debouncedQuery, true)}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={<View style={styles.center}><Text style={styles.centerText}>{t.tabSessions === "会话" ? "没有匹配的会话" : "No matching sessions"}</Text></View>}
          ListFooterComponent={sessions.length > 0 ? listFooter : null}
        />
      )}

      {/* 底部悬浮 Floating Toolbar：绿色微光小圆点 [活跃中 | 全部] 切换 */}
      {!searchBarOpen && (
        <View style={styles.floatingBarContainer} pointerEvents="box-none">
          <View style={[styles.floatingPill, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.floatingTabBtn, tab === "active" && { backgroundColor: theme.accent }]}
              onPress={() => setTab("active")}
            >
              <View style={[styles.greenDot, tab === "active" && { backgroundColor: "#fff" }]} />
              <Text style={[styles.floatingTabText, { color: tab === "active" ? "#fff" : theme.muted }]}>
                {t.filterActive}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.floatingTabBtn, tab === "all" && { backgroundColor: theme.accent }]}
              onPress={() => setTab("all")}
            >
              <Text style={[styles.floatingTabText, { color: tab === "all" ? "#fff" : theme.muted }]}>
                {t.filterAll}
              </Text>
            </TouchableOpacity>
          </View>

          {/* 右下角独立搜索 FAB */}
          <TouchableOpacity
            style={[styles.searchFab, { backgroundColor: theme.accent }]}
            onPress={() => setSearchBarOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="搜索会话"
          >
            <LineIcon name="search" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {/* 底部原位弹出的整行全宽搜索框 */}
      {searchBarOpen && (
        <View style={styles.searchBarPopupWrap}>
          <View style={[styles.searchBarPopup, { backgroundColor: theme.cardBg, borderColor: theme.accent }]}>
            <LineIcon name="search" size={16} color={theme.muted} style={{ marginLeft: 6 }} />
            <TextInput
              style={[styles.searchPopupInput, { color: theme.text }]}
              value={query}
              onChangeText={setQuery}
              placeholder={t.searchPlaceholder}
              placeholderTextColor={theme.dim}
              autoFocus
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery("")} style={{ padding: 4 }}>
                <LineIcon name="x" size={14} color={theme.muted} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.searchDoneBtn, { backgroundColor: theme.accent }]}
              onPress={() => setSearchBarOpen(false)}
            >
              <Text style={styles.searchDoneText}>{t.tabSessions === "会话" ? "完成" : "Done"}</Text>
            </TouchableOpacity>
          </View>
        </View>
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
    topHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 12,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 4,
      elevation: 4,
      zIndex: 10,
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
    sessionHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
    liveDotBase: { width: 8, height: 8, borderRadius: 4 },
    liveDotActive: { backgroundColor: theme.success },
    liveDotIdle: { backgroundColor: theme.muted },
    modelBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 12,
      backgroundColor: hexToRgba(theme.accent, 0.14),
      borderWidth: 1,
      borderColor: hexToRgba(theme.accent, 0.35),
    },
    modelBadgeText: { fontSize: 10, fontFamily: "monospace", color: theme.accent },
    pathRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4, marginBottom: 8 },
    pathText: { fontSize: 11, fontFamily: "monospace", color: theme.muted, flex: 1 },
    bentoGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      backgroundColor: theme.secondaryContainer ?? theme.inputBg,
      borderRadius: MIUIX_RADIUS.md,
      padding: 8,
      gap: 6,
      borderWidth: 1,
      borderColor: theme.border,
      marginBottom: 6,
    },
    bentoCell: { width: "48%" },
    bentoCellLabel: { fontSize: 9, color: theme.dim, marginBottom: 1 },
    bentoCellValue: { fontSize: 11, fontFamily: "monospace", color: theme.text, fontWeight: "600" },
    contextTrack: { width: "100%", height: 3, backgroundColor: theme.border, borderRadius: 2, overflow: "hidden" },
    contextFill: { height: "100%", borderRadius: 2 },
    floatingBarContainer: {
      position: "absolute",
      bottom: 24,
      left: 16,
      right: 16,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      zIndex: 50,
    },
    floatingPill: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: 20,
      padding: 3,
      borderWidth: 1,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 10,
      elevation: 6,
      gap: 4,
    },
    floatingTabBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
    },
    floatingTabText: { fontSize: 12, fontWeight: "600" },
    greenDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.success },
    searchFab: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 8,
    },
    searchBarPopupWrap: {
      position: "absolute",
      bottom: 24,
      left: 16,
      right: 16,
      zIndex: 60,
    },
    searchBarPopup: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: MIUIX_RADIUS.lg,
      borderWidth: 1.5,
      paddingHorizontal: 8,
      paddingVertical: 4,
      gap: 6,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 10,
    },
    searchPopupInput: { flex: 1, fontSize: 13, paddingVertical: 6, paddingHorizontal: 4 },
    searchDoneBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: MIUIX_RADIUS.md },
    searchDoneText: { color: "#fff", fontSize: 12, fontWeight: "700" },
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

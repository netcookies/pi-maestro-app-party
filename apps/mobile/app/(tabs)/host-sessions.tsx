import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHost } from "../../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../../src/theme";
import { LineIcon } from "../../src/components/LineIcon";
import { HostSessionCard } from "../../src/components/HostSessionCard";
import { useI18n } from "../../src/i18n";
import { sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";
import {
  beginFilterRequest,
  createFilterState,
  filterSessionSummaries,
  isFilterResponseCurrent,
  isPageResponseCurrent,
  updateFilterState,
  type FilterState,
} from "../../src/filter-state";
import { canLoadMoreSessions, isCurrentSessionSummary, mergeHostSessionPage, patchHostSessionSummary, removeHostSessionSummary, sessionRoleRevision } from "../../src/host-session-pagination";
import { routeForOpenedSession, selectSessionTarget } from "../../src/session-navigation";


const PAGE_SIZE = 30;

type SessionView = "current" | "all";

type Row = { type: "group"; key: string; cwd: string; count: number } | { type: "session"; key: string; session: HostSessionSummary };

export default function HostSessionsScreen({ active = true }: { active?: boolean }) {
  const router = useRouter();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { state, listHostSessions, loadSessionHistory, isConnected, connectionState, hostUrl } = useHost();
  const sessionRoleRevisionValue = useMemo(
    () => sessionRoleRevision(state.workspaceWindowProjections.values()),
    [state.workspaceWindowProjections],
  );
  const sessionRoleRevisionRef = useRef(sessionRoleRevisionValue);

  const [filterState, setFilterState] = useState<FilterState>(() => createFilterState());
  const filterStateRef = useRef(filterState);
  const [queryInput, setQueryInput] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionView, setSessionView] = useState<SessionView>("current");
  const [filterOpen, setFilterOpen] = useState(false);
  // 草稿多选：底部抽屉中勾选，点应用才提交（避免每次勾选都触发一次请求）
  const [cwdDraft, setCwdDraft] = useState<string[]>([]);
  const [sessions, setSessions] = useState<HostSessionSummary[]>([]);
  const sessionsRef = useRef<HostSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const nextCursorRef = useRef<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const firstPageInFlightRef = useRef(false);
  const lastRequestedCursorRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const refreshedUnknownPatchRef = useRef(new Map<string, number>());
  const hydratedConnectionGenerationRef = useRef<number | null>(null);

  // Host summary 事件只 patch 当前已加载行；注销的 exact target 必须从列表移除，
  // 否则用户会继续点到已关闭 TUI 的 stale card。
  useEffect(() => {
    if (state.sessionSummaryPatches.size === 0 || sessionsRef.current.length === 0) return;
    let next = sessionsRef.current;
    for (const update of state.sessionSummaryPatches.values()) {
      if (update.patch.reset && update.patch.runtimeStatus === "sleeping") {
        const removed = removeHostSessionSummary(next, update.target);
        if (removed.length !== next.length) next = removed;
        continue;
      }
      const patched = patchHostSessionSummary(next, update.target, update.patch, update.revision);
      if (patched.some((session, index) => session !== next[index])) next = patched;
    }
    if (next === sessionsRef.current) return;
    sessionsRef.current = next;
    setSessions(next);
  }, [state.sessionSummaryPatches]);

  const setFilter = useCallback((patch: Partial<FilterState["filter"]>) => {
    const next = updateFilterState(filterStateRef.current, patch);
    filterStateRef.current = next;
    setFilterState(next);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setFilter({ query: queryInput }), 250);
    return () => clearTimeout(timer);
  }, [queryInput, setFilter]);

  const loadFirstPage = useCallback(async (refresh = false) => {
    if (!active) return;
    if (!isConnected) {
      hydratedConnectionGenerationRef.current = null;
      sessionsRef.current = [];
      setSessions([]);
      setLoading(true);
      return;
    }
    const current = filterStateRef.current;
    if (!refresh && hydratedConnectionGenerationRef.current === state.connectionGeneration
      && !current.filter.query && !current.filter.cwds?.length && state.hostSessionList
      && state.hostSessionList.sessions.every((session) => session.presentation?.visibility !== "monitor_tab")) {
      const page = mergeHostSessionPage([], state.hostSessionList, true);
      const scoped = filterSessionSummaries(page.sessions, current.filter);
      sessionsRef.current = scoped;
      setSessions(scoped);
      nextCursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setTotal(page.total);
      setLoading(false);
      return;
    }
    const token = beginFilterRequest(current);
    const hadVisibleSessions = sessionsRef.current.length > 0;
    firstPageInFlightRef.current = true;
    lastRequestedCursorRef.current = undefined;
    setLoadingMore(false);
    sessionsRef.current = [];
    setSessions([]);
    setError(null);
    if (refresh || hadVisibleSessions) {
      setRefreshing(refresh || hadVisibleSessions);
      setLoading(true);
    } else {
      setLoading(true);
    }
    try {
      const list = await listHostSessions({
        limit: PAGE_SIZE,
        ...(current.filter.query ? { query: current.filter.query } : {}),
        // 单选语义映射到服务端 cwd 过滤；多选时本地再 scope（race-safe 由 generation token 保证）
        ...(current.filter.cwds?.length === 1 ? { cwd: current.filter.cwds[0] } : {}),
      });
      if (!isFilterResponseCurrent(filterStateRef.current, token)) return;
      const page = mergeHostSessionPage([], list, true);
      const scoped = filterSessionSummaries(page.sessions, current.filter);
      sessionsRef.current = scoped;
      setSessions(scoped);
      hydratedConnectionGenerationRef.current = state.connectionGeneration;
      nextCursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (e) {
      if (isFilterResponseCurrent(filterStateRef.current, token)) setError(e instanceof Error ? e.message : "加载会话失败");
    } finally {
      if (isFilterResponseCurrent(filterStateRef.current, token)) {
        firstPageInFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [active, isConnected, listHostSessions, state.connectionGeneration, state.hostSessionList]);

  useEffect(() => {
    if (!active) return;
    void loadFirstPage();
  }, [active, loadFirstPage, filterState.generation]);

  useEffect(() => {
    if (sessionRoleRevisionRef.current === sessionRoleRevisionValue) return;
    sessionRoleRevisionRef.current = sessionRoleRevisionValue;
    if (isConnected) void loadFirstPage(true);
  }, [isConnected, loadFirstPage, sessionRoleRevisionValue]);

  useEffect(() => {
    if (!isConnected || state.sessionSummaryPatches.size === 0 || firstPageInFlightRef.current) return;
    for (const update of state.sessionSummaryPatches.values()) {
      if (update.patch.reset) continue;
      const key = sessionTargetKey(update.target);
      const loaded = sessionsRef.current.some((session) => session.targetKey === key);
      if (loaded || refreshedUnknownPatchRef.current.get(key) === update.revision) continue;
      refreshedUnknownPatchRef.current.set(key, update.revision);
      void loadFirstPage(true);
      break;
    }
  }, [isConnected, loadFirstPage, state.sessionSummaryPatches]);

  const loadMore = useCallback(async () => {
    const current = filterStateRef.current;
    const cursor = nextCursorRef.current;
    if (!canLoadMoreSessions({
      connected: isConnected,
      hasMore,
      nextCursor: cursor,
      loading: loadingMoreRef.current,
      lastRequestedCursor: lastRequestedCursorRef.current,
      firstPageInFlight: firstPageInFlightRef.current,
    })) return;
    const token = beginFilterRequest(current, cursor);
    loadingMoreRef.current = true;
    lastRequestedCursorRef.current = cursor;
    setLoadingMore(true);
    try {
      const list = await listHostSessions({
        limit: PAGE_SIZE,
        cursor,
        ...(current.filter.query ? { query: current.filter.query } : {}),
        ...(current.filter.cwds?.length === 1 ? { cwd: current.filter.cwds[0] } : {}),
      });
      if (!isPageResponseCurrent(filterStateRef.current, token, nextCursorRef.current)) return;
      const page = mergeHostSessionPage(sessionsRef.current, list, false);
      const scoped = filterSessionSummaries(page.sessions, current.filter);
      sessionsRef.current = scoped;
      setSessions(scoped);
      nextCursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setTotal(page.total);
    } catch (e) {
      if (isPageResponseCurrent(filterStateRef.current, token, nextCursorRef.current)) setError(e instanceof Error ? e.message : "加载更多失败");
      lastRequestedCursorRef.current = undefined;
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, isConnected, listHostSessions]);

  const handleOpen = useCallback(async (session: HostSessionSummary) => {
    if (opening) return;
    setOpening(session.targetKey ?? session.id);
    setError(null);
    try {
      // Mobile 只选择 Host 发布的 exact target，不执行任何 Host session lifecycle。
      const opened = selectSessionTarget(session);
      await loadSessionHistory(opened.sessionId, opened.targetKey);
      router.push(routeForOpenedSession(opened));
    } catch (error) {
      const raw = error instanceof Error ? error.message : "";
      setError(raw === "session_target_unavailable"
        ? "该会话没有可验证的精确目标，暂时无法打开"
        : raw || "打开会话失败");
    } finally {
      setOpening(null);
    }
  }, [loadSessionHistory, opening, router]);

  const cwdOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.cwd))).sort(), [sessions]);
  const scopedSessions = useMemo(() => {
    const filtered = filterSessionSummaries(sessions, filterState.filter);
    return sessionView === "all" ? filtered : filtered.filter(isCurrentSessionSummary);
  }, [filterState.filter, sessionView, sessions]);
  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, HostSessionSummary[]>();
    for (const session of scopedSessions) groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session]);
    return Array.from(groups.entries()).flatMap(([cwd, group]) => [
      { type: "group", key: `g:${cwd}`, cwd, count: group.length } as Row,
      ...group.map((session) => ({ type: "session", key: `s:${session.targetKey ?? session.id}`, session } as Row)),
    ]);
  }, [scopedSessions]);

  const selectedCount = (filterState.filter.cwds?.length ?? 0) + (filterState.filter.query ? 1 : 0);
  const loadedLabel = typeof total === "number" ? `${sessions.length}/${total}` : String(sessions.length);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.headerContainer, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
          <View style={styles.topHeader}>
            <View style={styles.headerTitleWrap}>
              <Text style={[styles.topHeaderTitle, { color: theme.text }]}>{t.tabSessions}</Text>
              <Text style={[styles.topHeaderSub, { color: theme.muted }]} numberOfLines={1}>
                {hostUrl ? hostUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "") : connectionState}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={() => setSearchOpen((value) => !value)} accessibilityRole="button" accessibilityLabel={t.searchPlaceholder} style={styles.iconButton}>
                <LineIcon name="search" size={18} color={theme.text} />
              </TouchableOpacity>
            </View>
          </View>
          {searchOpen && (
            <View style={styles.searchRow}>
              <LineIcon name="search" size={16} color={theme.muted} />
              <TextInput autoFocus value={queryInput} onChangeText={setQueryInput} placeholder={t.searchPlaceholder} placeholderTextColor={theme.dim} style={[styles.searchInput, { color: theme.text }]} />
              {queryInput.length > 0 && <TouchableOpacity onPress={() => setQueryInput("")} accessibilityRole="button" accessibilityLabel={t.clearSearch}><LineIcon name="x" size={15} color={theme.muted} /></TouchableOpacity>}
            </View>
          )}
        </SafeAreaView>
      </View>

      {error && sessions.length > 0 ? (
        <TouchableOpacity style={styles.errorPanel} onPress={() => setError(null)} accessibilityRole="button">
          <Text style={styles.errorText}>{error}</Text>
        </TouchableOpacity>
      ) : null}
      {error && sessions.length === 0 ? <View style={styles.errorPanel}><Text style={styles.errorText}>{error}</Text><TouchableOpacity onPress={() => void loadFirstPage()}><Text style={[styles.retryText, { color: theme.accent }]}>{t.retry}</Text></TouchableOpacity></View> : !isConnected || loading ? <View style={styles.center}><ActivityIndicator color={theme.accent} /><Text style={styles.centerText}>{t.loadingSessions}</Text></View> : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => item.type === "group" ? <View style={styles.group}><Text style={styles.groupTitle}>{cwdName(item.cwd)} · {item.count}</Text><Text style={styles.groupPath} numberOfLines={1}>{item.cwd}</Text></View> : <HostSessionCard session={item.session} opening={opening === (item.session.targetKey ?? item.session.id)} onPress={() => void handleOpen(item.session)} />}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshing={refreshing}
          onRefresh={() => void loadFirstPage(true)}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={<View style={styles.center}><Text style={styles.centerText}>{t.noMatchingSessions}</Text></View>}
          ListFooterComponent={rows.length > 0 ? <View style={styles.footer}>{loadingMore && <ActivityIndicator color={theme.accent} />}<Text style={styles.footerText}>{loadedLabel}</Text></View> : null}
        />
      )}

      <View style={styles.floatingBarContainer} pointerEvents="box-none">
          <View style={[styles.floatingPill, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.floatingTabBtn, sessionView === "current" && { backgroundColor: theme.accent }]}
              onPress={() => setSessionView("current")}
              accessibilityRole="button"
              accessibilityLabel={t.filterCurrent}
              accessibilityState={{ selected: sessionView === "current" }}
            >
              <View style={[styles.greenDot, sessionView === "current" && { backgroundColor: "#fff" }]} />
              <Text style={[styles.floatingTabText, { color: sessionView === "current" ? "#fff" : theme.muted }]}>
                {t.filterCurrent}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.floatingTabBtn, sessionView === "all" && { backgroundColor: theme.accent }]}
              onPress={() => setSessionView("all")}
              accessibilityRole="button"
              accessibilityLabel={t.filterAll}
              accessibilityState={{ selected: sessionView === "all" }}
            >
              <Text style={[styles.floatingTabText, { color: sessionView === "all" ? "#fff" : theme.muted }]}>
                {t.filterAll}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.filterFab, { backgroundColor: theme.accent }]}
            onPress={() => {
              setCwdDraft(filterState.filter.cwds ?? []);
              setFilterOpen(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={t.filterSessions}
          >
            <LineIcon name="filter" size={19} color="#fff" />
            {selectedCount > 0 && <Text style={styles.filterCount}>{selectedCount}</Text>}
          </TouchableOpacity>
        </View>

      <Modal visible={filterOpen} transparent animationType="slide" onRequestClose={() => setFilterOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
          <View style={[styles.filterSheet, { backgroundColor: theme.cardBg }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: theme.text }]}>{t.filterProjects}</Text>
              <TouchableOpacity onPress={() => setFilterOpen(false)} accessibilityRole="button" accessibilityLabel={t.close}>
                <LineIcon name="x" size={18} color={theme.muted} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.filterOption, (cwdDraft.length === 0) && { borderColor: theme.accent }]}
              onPress={() => setCwdDraft([])}
            >
              <Text style={[styles.filterOptionText, { color: theme.text }]}>{t.allProjects}</Text>
              {cwdDraft.length === 0 && <LineIcon name="check" size={16} color={theme.accent} />}
            </TouchableOpacity>
            {cwdOptions.map((cwd) => {
              const selected = cwdDraft.includes(cwd);
              return (
                <TouchableOpacity
                  key={cwd}
                  style={[styles.filterOption, selected && { borderColor: theme.accent }]}
                  onPress={() => setCwdDraft((prev) => (prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd]))}
                >
                  <Text style={[styles.filterOptionText, { color: theme.text }]} numberOfLines={1}>{cwd}</Text>
                  {selected && <LineIcon name="check" size={16} color={theme.accent} />}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={[styles.filterApplyBtn, { backgroundColor: theme.buttonPrimary }]}
              onPress={() => {
                setFilter({ cwds: cwdDraft.length > 0 ? cwdDraft : undefined });
                setFilterOpen(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={t.apply}
            >
              <Text style={styles.filterApplyText}>{t.apply}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function cwdName(cwd: string): string { return cwd.split("/").filter(Boolean).pop() ?? cwd; }

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1 },
    headerContainer: { borderBottomWidth: StyleSheet.hairlineWidth, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 3, elevation: 3, zIndex: 2 },
    topHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
    headerTitleWrap: { flex: 1, minWidth: 0 },
    topHeaderTitle: { fontSize: 20, fontWeight: "700" },
    topHeaderSub: { fontSize: 11, fontFamily: "monospace", marginTop: 2 },
    headerActions: { flexDirection: "row", gap: 8, marginLeft: 12 },
    iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border },
    filterCount: { position: "absolute", right: -3, top: -4, color: "#fff", backgroundColor: theme.warning, fontSize: 9, minWidth: 14, height: 14, borderRadius: 7, textAlign: "center", overflow: "hidden" },
    searchRow: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 10, paddingHorizontal: 10, height: 40, borderRadius: MIUIX_RADIUS.md, backgroundColor: theme.inputBg },
    searchInput: { flex: 1, fontSize: 13 },
    list: { padding: MIUIX_SPACE.lg, paddingBottom: 112 },
    floatingBarContainer: { position: "absolute", bottom: 20, left: 20, right: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center", zIndex: 5 },
    floatingPill: { flexDirection: "row", alignItems: "center", borderRadius: 20, padding: 3, borderWidth: 1, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, elevation: 5 },
    floatingTabBtn: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 34, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
    floatingTabText: { fontSize: 11, fontWeight: "700" },
    greenDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.success },
    filterFab: { position: "relative", width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 6, elevation: 6 },
    group: { marginTop: 6, marginBottom: 8 },
    groupTitle: { color: theme.text, fontSize: MIUIX_TYPE.footnote1, fontWeight: "700" },
    groupPath: { color: theme.dim, fontSize: 10, fontFamily: "monospace", marginTop: 2 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
    centerText: { color: theme.muted, marginTop: 10 },
    errorPanel: { alignItems: "center", padding: 24, gap: 10 },
    errorText: { color: theme.error, textAlign: "center" },
    retryText: { fontWeight: "700" },
    footer: { alignItems: "center", gap: 6, paddingVertical: 18 },
    footerText: { color: theme.dim, fontSize: 10, fontFamily: "monospace" },
    modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
    filterSheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, maxHeight: "75%" },
    sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
    sheetTitle: { fontSize: 17, fontWeight: "700" },
    filterOption: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, borderWidth: 1, borderColor: theme.border, borderRadius: MIUIX_RADIUS.md, padding: 12, marginBottom: 8 },
    filterOptionText: { fontSize: 13, flex: 1 },
    filterApplyBtn: { borderRadius: MIUIX_RADIUS.md, padding: 12, alignItems: "center", marginTop: 4 },
    filterApplyText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  });
}

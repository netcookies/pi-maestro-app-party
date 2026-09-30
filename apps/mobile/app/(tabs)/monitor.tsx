import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHost } from "../../src/store";
import { useTheme, MIUIX_SPACE, MIUIX_TYPE } from "../../src/theme";
import { LineIcon } from "../../src/components/LineIcon";
import { PulsingDot } from "../../src/components/PulsingDot";
import { HostSessionCard } from "../../src/components/HostSessionCard";
import { useI18n } from "../../src/i18n";
import { sessionTargetKey, type HostSessionSummary } from "@maestro-mobile/shared";
import { routeForOpenedSession, selectSessionTarget } from "../../src/session-navigation";
import { filterSessionsByVisibility, mergeHostSessionPage, patchHostSessionSummary, removeHostSessionSummary, sessionRoleRevision } from "../../src/host-session-pagination";

const PAGE_SIZE = 100;

export default function MonitorScreen({ active = true }: { active?: boolean }) {
  const router = useRouter();
  const { state, isConnected, listHostSessions, loadSessionHistory } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<HostSessionSummary[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const summaryPatchesRef = useRef(state.sessionSummaryPatches);
  summaryPatchesRef.current = state.sessionSummaryPatches;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const monitorRoleRevision = useMemo(
    () => sessionRoleRevision(state.workspaceWindowProjections.values()),
    [state.workspaceWindowProjections],
  );
  const monitorRoleRevisionRef = useRef(monitorRoleRevision);
  monitorRoleRevisionRef.current = monitorRoleRevision;

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    if (!isConnected) {
      setSessions([]);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    setError(null);
    const roleRevision = monitorRoleRevisionRef.current;
    try {
      let response = await listHostSessions({ limit: PAGE_SIZE, includeMonitor: true });
      let summaries = response.sessions;
      const seenCursors = new Set<string>();
      while (response.hasMore) {
        const cursor = response.nextCursor;
        if (!cursor || seenCursors.has(cursor)) throw new Error("monitor_session_pagination_stalled");
        seenCursors.add(cursor);
        response = await listHostSessions({ limit: PAGE_SIZE, cursor, includeMonitor: true });
        summaries = mergeHostSessionPage(summaries, response, false).sessions;
      }
      let monitorSessions = filterSessionsByVisibility(summaries, "monitor_tab");
      if (monitorSessions.some((session) => !session.target)) throw new Error("monitor_session_target_unavailable");
      for (const update of summaryPatchesRef.current.values()) {
        if (update.patch.reset && update.patch.runtimeStatus === "sleeping") {
          monitorSessions = removeHostSessionSummary(monitorSessions, update.target);
        } else {
          monitorSessions = patchHostSessionSummary(monitorSessions, update.target, update.patch, update.revision);
        }
      }
      if (refreshGenerationRef.current === generation && monitorRoleRevisionRef.current === roleRevision) setSessions(monitorSessions);
    } catch (refreshError) {
      if (refreshGenerationRef.current === generation && monitorRoleRevisionRef.current === roleRevision) setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      if (refreshGenerationRef.current === generation && monitorRoleRevisionRef.current === roleRevision) setRefreshing(false);
    }
  }, [isConnected, listHostSessions, monitorRoleRevision]);

  const openSession = useCallback(async (session: HostSessionSummary) => {
    if (opening) return;
    const key = session.targetKey ?? (session.target ? sessionTargetKey(session.target) : session.id);
    setOpening(key);
    setError(null);
    try {
      const opened = selectSessionTarget(session);
      await loadSessionHistory(opened.sessionId, opened.targetKey);
      router.push(routeForOpenedSession(opened));
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setOpening(null);
    }
  }, [loadSessionHistory, opening, router]);

  useEffect(() => {
    if (state.sessionSummaryPatches.size === 0) return;
    setSessions((current) => {
      let next = current;
      for (const update of state.sessionSummaryPatches.values()) {
        if (update.patch.reset && update.patch.runtimeStatus === "sleeping") {
          const filtered = removeHostSessionSummary(next, update.target);
          if (filtered.length !== next.length) next = filtered;
          continue;
        }
        const patched = patchHostSessionSummary(next, update.target, update.patch, update.revision);
        if (patched.some((session, index) => session !== next[index])) next = patched;
      }
      return next === current ? current : next;
    });
  }, [state.sessionSummaryPatches]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, isConnected, monitorRoleRevision, refresh]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.headerContainer, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
          <View style={styles.topHeader}>
            <Text style={[styles.title, { color: theme.text }]}>{t.tabMonitor}</Text>
            <View
              style={[
                styles.connection,
                {
                  borderColor: isConnected ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)",
                  backgroundColor: isConnected ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                },
              ]}
            >
              <PulsingDot color={isConnected ? theme.success : theme.error} size={6} active={isConnected} />
              <Text style={{ color: isConnected ? theme.success : theme.error, fontSize: 11 }}>{isConnected ? t.onlineBadge : t.offlineBadge}</Text>
            </View>
          </View>
        </SafeAreaView>
      </View>
      {sessions.length === 0 ? (
        <View style={styles.empty}>
          <LineIcon name="eye" size={26} color={theme.dim} />
          <Text style={[styles.emptyTitle, { color: theme.muted }]}>{error ?? t.noMonitorSessions}</Text>
          <Text style={[styles.emptyText, { color: theme.dim }]}>{t.noMonitorSessionsDesc}</Text>
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(session) => session.targetKey ?? (session.target ? sessionTargetKey(session.target) : session.id)}
          renderItem={({ item }) => (
            <HostSessionCard
              session={item}
              opening={opening === (item.targetKey ?? (item.target ? sessionTargetKey(item.target) : item.id))}
              onPress={() => void openSession(item)}
            />
          )}
          contentContainerStyle={styles.list}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          ListHeaderComponent={error ? <Text style={[styles.errorText, { color: theme.error }]}>{error}</Text> : null}
        />
      )}
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1 },
    headerContainer: { borderBottomWidth: StyleSheet.hairlineWidth, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 3, elevation: 3 },
    topHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
    title: { fontSize: 20, fontWeight: "700" },
    connection: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
    list: { padding: MIUIX_SPACE.lg, paddingBottom: 32 },
    errorText: { paddingBottom: 10, fontSize: 11 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
    emptyTitle: { fontSize: MIUIX_TYPE.body1, fontWeight: "700", marginTop: 8, textAlign: "center" },
    emptyText: { fontSize: MIUIX_TYPE.footnote1, textAlign: "center" },
  });
}

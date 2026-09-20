import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHost } from "../../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../../src/theme";
import { LineIcon } from "../../src/components/LineIcon";
import { PulsingDot } from "../../src/components/PulsingDot";
import { SpringCard } from "../../src/components/SpringCard";
import { useI18n } from "../../src/i18n";
import { monitorWindowKey, monitorWindows } from "../../src/monitor-data";
import type { MonitorWindowSummary } from "@maestro-mobile/shared";

export default function MonitorScreen({ active = true }: { active?: boolean }) {
  const { state, isConnected, refreshMonitor } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const windows = useMemo(() => monitorWindows(state.monitor), [state.monitor]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConnected) return;
    setRefreshing(true);
    try {
      await refreshMonitor();
    } catch {
      // Store exposes the failure through its existing lastError channel.
    } finally {
      setRefreshing(false);
    }
  }, [isConnected, refreshMonitor]);

  useEffect(() => {
    if (active && isConnected) void refresh();
  }, [active, isConnected, refresh]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.headerContainer, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
        <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
          <View style={styles.topHeader}>
            <View><Text style={[styles.title, { color: theme.text }]}>{t.tabMonitor}</Text><Text style={[styles.subtitle, { color: theme.muted }]}>{t.monitorReadOnly}</Text></View>
            <View style={styles.connection}><PulsingDot color={isConnected ? theme.success : theme.error} size={6} active={isConnected} /><Text style={{ color: isConnected ? theme.success : theme.error, fontSize: 11 }}>{isConnected ? t.onlineBadge : t.offlineBadge}</Text></View>
          </View>
        </SafeAreaView>
      </View>
      {windows.length === 0 ? (
        <View style={styles.empty}>
          <LineIcon name="eye" size={26} color={theme.dim} />
          <Text style={[styles.emptyTitle, { color: theme.muted }]}>{t.noMonitorSessions}</Text>
          <Text style={[styles.emptyText, { color: theme.dim }]}>{t.noMonitorSessionsDesc}</Text>
        </View>
      ) : (
        <FlatList
          data={windows}
          keyExtractor={monitorWindowKey}
          renderItem={({ item }) => {
            const key = monitorWindowKey(item);
            return (
              <MonitorCard
                window={item}
                expanded={expandedKey === key}
                theme={theme}
                styles={styles}
                t={t}
                onPress={() => setExpandedKey((current) => current === key ? null : key)}
              />
            );
          }}
          contentContainerStyle={styles.list}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
        />
      )}
    </View>
  );
}

function MonitorCard({ window, expanded, theme, styles, t, onPress }: {
  window: MonitorWindowSummary;
  expanded: boolean;
  theme: ReturnType<typeof useTheme>["theme"];
  styles: ReturnType<typeof makeStyles>;
  t: ReturnType<typeof useI18n>["t"];
  onPress: () => void;
}) {
  const control = window.presentation?.control;
  const running = window.runtimeStatus === "running";
  const title = window.name || window.sessionId;
  return (
    <SpringCard style={styles.card} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title} ${t.openSessionDetail}`}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <PulsingDot color={running ? theme.success : theme.muted} active={running} size={8} />
          <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>{title}</Text>
        </View>
        <LineIcon name={expanded ? "chevronDown" : "chevronRight"} size={16} color={theme.muted} />
      </View>
      <View style={styles.pathRow}><LineIcon name="folder" size={13} color={theme.muted} /><Text style={[styles.path, { color: theme.muted }]} numberOfLines={1}>{window.cwd ?? t.unknownPath}</Text></View>
      <View style={[styles.detail, { backgroundColor: theme.inputBg, borderColor: theme.border }]}>
        <Text style={[styles.detailText, { color: theme.muted }]}>{window.runtimeStatus}</Text>
        <Text style={[styles.detailText, { color: theme.muted }]}>{window.lifecycle}</Text>
        <Text style={[styles.detailText, { color: theme.accent }]}>{window.workStatus}</Text>
      </View>
      <View style={styles.capabilities}>
        <Capability label={t.promptCapability} enabled={control?.canPrompt === true} theme={theme} />
        <Capability label={t.steerCapability} enabled={control?.canSteer === true} theme={theme} />
        <Capability label={t.followUpCapability} enabled={control?.canFollowUp === true} theme={theme} />
        <Capability label={t.abortCapability} enabled={control?.canAbort === true} theme={theme} />
      </View>
      {expanded ? (
        <View style={[styles.expanded, { borderTopColor: theme.border }]}>
          {window.objective ? <Text style={[styles.objective, { color: theme.text }]}>{window.objective}</Text> : null}
          {window.pendingAsk ? (
            <View style={[styles.notice, { borderColor: theme.warning }]}>
              <Text style={[styles.noticeTitle, { color: theme.warning }]}>{window.pendingAsk.title ?? window.pendingAsk.toolName}</Text>
              {window.pendingAsk.question ? <Text style={[styles.noticeText, { color: theme.text }]}>{window.pendingAsk.question}</Text> : null}
            </View>
          ) : null}
          {window.attention.map((item) => (
            <View key={`${item.code}:${item.message}`} style={[styles.notice, { borderColor: item.severity === "error" ? theme.error : theme.warning }]}>
              <Text style={[styles.noticeTitle, { color: item.severity === "error" ? theme.error : theme.warning }]}>{item.code}</Text>
              <Text style={[styles.noticeText, { color: theme.text }]}>{item.message}</Text>
            </View>
          ))}
          {window.todos.map((todo) => (
            <View key={todo.id} style={styles.todoRow}>
              <LineIcon name={todo.status === "completed" ? "check" : "plan"} size={14} color={todo.status === "completed" ? theme.success : theme.muted} />
              <Text style={[styles.todoSubject, { color: theme.text }]} numberOfLines={2}>{todo.subject}</Text>
              <Text style={[styles.todoStatus, { color: theme.muted }]}>{todo.status}</Text>
            </View>
          ))}
          <Text style={[styles.identity, { color: theme.dim }]} numberOfLines={1}>
            {window.identity.workspaceId} / {window.identity.ownerId} / {window.identity.endpointId}
          </Text>
        </View>
      ) : null}
    </SpringCard>
  );
}

function Capability({ label, enabled, theme }: { label: string; enabled: boolean; theme: ReturnType<typeof useTheme>["theme"] }) {
  return <View style={[stylesStatic.capability, { borderColor: theme.border }, enabled && { borderColor: theme.accent, backgroundColor: theme.secondaryContainer ?? theme.inputBg }]}><Text style={{ color: enabled ? theme.accent : theme.dim, fontSize: 9, fontWeight: "600" }}>{label}</Text></View>;
}

const stylesStatic = StyleSheet.create({
  capability: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
});

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1 },
    headerContainer: { borderBottomWidth: StyleSheet.hairlineWidth, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 3, elevation: 3 },
    topHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
    title: { fontSize: 20, fontWeight: "700" },
    subtitle: { fontSize: 11, fontFamily: "monospace", marginTop: 2 },
    connection: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: theme.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
    list: { padding: MIUIX_SPACE.lg, paddingBottom: 32 },
    card: { backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.border, borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    cardTitleWrap: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    cardTitle: { fontSize: 14, fontWeight: "700", flex: 1 },
    pathRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 7, marginBottom: 9 },
    path: { flex: 1, fontSize: 11, fontFamily: "monospace" },
    detail: { flexDirection: "row", justifyContent: "space-between", gap: 8, borderWidth: 1, borderRadius: MIUIX_RADIUS.md, padding: 9 },
    detailText: { minWidth: 0, flexShrink: 1, fontSize: 10, fontFamily: "monospace" },
    capabilities: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 9 },
    expanded: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 12, paddingTop: 12, gap: 8 },
    objective: { fontSize: 12, lineHeight: 17 },
    notice: { borderLeftWidth: 2, paddingLeft: 9, gap: 3 },
    noticeTitle: { fontSize: 10, fontWeight: "700" },
    noticeText: { fontSize: 11, lineHeight: 16 },
    todoRow: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
    todoSubject: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: 16 },
    todoStatus: { flexShrink: 0, fontSize: 9, fontFamily: "monospace" },
    identity: { fontSize: 9, fontFamily: "monospace", marginTop: 2 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
    emptyTitle: { fontSize: MIUIX_TYPE.body1, fontWeight: "700", marginTop: 8 },
    emptyText: { fontSize: MIUIX_TYPE.footnote1, textAlign: "center" },
  });
}

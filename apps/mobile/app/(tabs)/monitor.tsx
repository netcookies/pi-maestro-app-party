import React, { useMemo } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useHost } from "../../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../../src/theme";
import { LineIcon } from "../../src/components/LineIcon";
import { PulsingDot } from "../../src/components/PulsingDot";
import { SpringCard } from "../../src/components/SpringCard";
import { useI18n } from "../../src/i18n";
import type { SessionState } from "@maestro-mobile/shared";

export default function MonitorScreen() {
  const router = useRouter();
  const { state, isConnected } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const sessions = useMemo(() => Array.from(state.sessions.values()).filter((session) => session.presentation?.visibility === "monitor_tab"), [state.sessions]);

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
      {sessions.length === 0 ? <View style={styles.empty}><LineIcon name="eye" size={26} color={theme.dim} /><Text style={[styles.emptyTitle, { color: theme.muted }]}>{t.noMonitorSessions}</Text><Text style={[styles.emptyText, { color: theme.dim }]}>{t.noMonitorSessionsDesc}</Text></View> : <FlatList data={sessions} keyExtractor={(session) => session.id} renderItem={({ item }) => <MonitorCard session={item} theme={theme} styles={styles} t={t} onPress={() => router.push({ pathname: "/session", params: { id: item.id } })} />} contentContainerStyle={styles.list} />}
    </View>
  );
}

function MonitorCard({ session, theme, styles, t, onPress }: { session: SessionState; theme: ReturnType<typeof useTheme>["theme"]; styles: ReturnType<typeof makeStyles>; t: ReturnType<typeof useI18n>["t"]; onPress: () => void }) {
  const presentation = session.presentation;
  const control = presentation?.control;
  const running = session.runState === "streaming";
  return <SpringCard style={styles.card} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${session.title} ${t.openSessionDetail}`}>
    <View style={styles.cardHeader}><View style={styles.cardTitleWrap}><PulsingDot color={running ? theme.success : theme.muted} active={running} size={8} /><Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>{session.title || session.id}</Text></View><LineIcon name="chevronRight" size={16} color={theme.muted} /></View>
    <View style={styles.pathRow}><LineIcon name="folder" size={13} color={theme.muted} /><Text style={[styles.path, { color: theme.muted }]} numberOfLines={1}>{session.cwd}</Text></View>
    <View style={[styles.detail, { backgroundColor: theme.inputBg, borderColor: theme.border }]}><Text style={[styles.detailText, { color: theme.muted }]}>{session.runState}</Text><Text style={[styles.detailText, { color: theme.muted }]}>{presentation?.role ?? "monitor"}</Text><Text style={[styles.detailText, { color: theme.accent }]}>{control?.mode ?? "readonly"}</Text></View>
    <View style={styles.capabilities}><Capability label={t.promptCapability} enabled={control?.canPrompt === true} theme={theme} /><Capability label={t.steerCapability} enabled={control?.canSteer === true} theme={theme} /><Capability label={t.followUpCapability} enabled={control?.canFollowUp === true} theme={theme} /><Capability label={t.abortCapability} enabled={control?.canAbort === true} theme={theme} /></View>
  </SpringCard>;
}

function Capability({ label, enabled, theme }: { label: string; enabled: boolean; theme: ReturnType<typeof useTheme>["theme"] }) { return <View style={[{ borderWidth: 1, borderColor: theme.border, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 }, enabled && { borderColor: theme.accent, backgroundColor: theme.secondaryContainer ?? theme.inputBg }]}><Text style={{ color: enabled ? theme.accent : theme.dim, fontSize: 9, fontWeight: "600" }}>{label}</Text></View>; }

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
    detail: { flexDirection: "row", justifyContent: "space-between", borderWidth: 1, borderRadius: MIUIX_RADIUS.md, padding: 9 },
    detailText: { fontSize: 10, fontFamily: "monospace" },
    capabilities: { flexDirection: "row", gap: 6, marginTop: 9 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
    emptyTitle: { fontSize: MIUIX_TYPE.body1, fontWeight: "700", marginTop: 8 },
    emptyText: { fontSize: MIUIX_TYPE.footnote1, textAlign: "center" },
  });
}

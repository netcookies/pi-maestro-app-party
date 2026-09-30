import React, { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { HostSessionSummary } from "@maestro-mobile/shared";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE } from "../theme";
import { LineIcon } from "./LineIcon";
import { PulsingDot } from "./PulsingDot";
import { SpringCard } from "./SpringCard";
import { formatRelativeTime, useI18n } from "../i18n";

export function HostSessionCard({ session, opening, onPress }: {
  session: HostSessionSummary;
  opening: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const status = session.runtimeStatus;
  const active = status !== "history";
  const context = session.context;
  const title = session.name || session.cwdName || session.title || session.id;
  const statusColor = status === "running" ? theme.success : status === "idle" ? "#0A84FF" : status === "sleeping" ? theme.warning : theme.dim;
  const statusLabel = status === "running" ? t.running : status === "idle" ? t.statusIdle : status === "sleeping" ? t.statusSleeping : t.statusHistory;
  const cacheDenominator = session.usage ? session.usage.input + session.usage.cacheRead : 0;
  const cacheHit = cacheDenominator > 0 && session.usage ? `${Math.round((session.usage.cacheRead / cacheDenominator) * 100)}%` : "--";

  return (
    <SpringCard style={[styles.sessionCard, active && { borderColor: theme.accent }]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title} · ${statusLabel}`}>
      <View style={styles.sessionHeader}>
        <View style={styles.sessionHeaderLeft}>
          <PulsingDot color={statusColor} active={active} size={8} />
          <Text style={styles.sessionTitle} numberOfLines={1}>{title}</Text>
        </View>
        <View style={[styles.badge, { borderColor: statusColor }]}>
          <Text style={[styles.badgeText, { color: statusColor }]}>#{session.id.slice(0, 8)}</Text>
        </View>
        {opening && <ActivityIndicator size="small" color={theme.accent} />}
      </View>
      <View style={styles.pathRow}>
        <LineIcon name="folder" size={13} color={theme.muted} />
        <Text style={styles.pathText} numberOfLines={1}>{session.cwd || session.path}</Text>
      </View>
      <View style={styles.stats}>
        <Stat label={t.contextLabel} value={context?.percent != null ? `${Math.round(context.percent)}%` : "--"} theme={theme} />
        <Stat label={t.tokensLabel} value={session.totalTokens ? `${Math.round(session.totalTokens / 1000)}k` : "--"} theme={theme} />
        <Stat label={t.cacheLabel} value={cacheHit} theme={theme} />
        <Stat label={t.messagesAndTime} value={`${session.messageCount} · ${status === "running" && session.activeSince ? `${t.statusActive} ${formatRelativeTime(session.activeSince, t)}` : formatRelativeTime(session.lastActivityAt ?? session.updatedAt, t)}`} theme={theme} />
      </View>
    </SpringCard>
  );
}

function Stat({ label, value, theme }: { label: string; value: string; theme: ReturnType<typeof useTheme>["theme"] }) {
  return (
    <View style={{ width: "48%" }}>
      <Text style={{ color: theme.dim, fontSize: 9 }}>{label}</Text>
      <Text style={{ color: theme.text, fontSize: 11, fontFamily: "monospace", fontWeight: "600", marginTop: 2 }}>{value}</Text>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    sessionCard: { backgroundColor: theme.cardBg, borderWidth: 1, borderColor: theme.border, borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    sessionHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    sessionHeaderLeft: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    sessionTitle: { color: theme.text, fontSize: 13, fontWeight: "700", flex: 1 },
    badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: theme.secondaryContainer ?? theme.inputBg, borderWidth: 1, borderColor: theme.border },
    badgeText: { color: theme.accent, fontSize: 9, fontFamily: "monospace", fontWeight: "600" },
    pathRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8, marginBottom: 8 },
    pathText: { color: theme.muted, fontSize: 11, fontFamily: "monospace", flex: 1 },
    stats: { flexDirection: "row", flexWrap: "wrap", columnGap: 8, rowGap: 6, backgroundColor: theme.inputBg, borderRadius: MIUIX_RADIUS.md, padding: 9, borderWidth: 1, borderColor: theme.border },
  });
}

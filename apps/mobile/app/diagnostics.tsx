import React, { useMemo } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../src/theme";
import { useI18n } from "../src/i18n";
import { clearDiagnostics, useDiagnostics, type DiagnosticKind } from "../src/diagnostics";
import { LineIcon } from "../src/components/LineIcon";

export default function DiagnosticsScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { lang, t } = useI18n();
  const entries = useDiagnostics();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const kindLabel = (kind: DiagnosticKind): string => {
    switch (kind) {
      case "connection_error": return t.diagnosticsKindConnection;
      case "notification": return t.diagnosticsKindNotification;
      case "ask": return t.diagnosticsKindAsk;
      case "plan": return t.diagnosticsKindPlan;
      case "local": return t.diagnosticsKindLocal;
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
        <View style={[styles.header, { borderBottomColor: theme.border, backgroundColor: theme.headerBg }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconButton} accessibilityRole="button" accessibilityLabel={t.backBtn}>
            <LineIcon name="arrowLeft" size={20} color={theme.text} />
          </TouchableOpacity>
          <View style={styles.headerTitleWrap}>
            <Text style={[styles.headerTitle, { color: theme.text }]}>{t.diagnosticsTitle}</Text>
            <Text style={[styles.headerSummary, { color: theme.muted }]}>{entries.length} {t.diagnosticsEntryCount}</Text>
          </View>
          <TouchableOpacity
            onPress={clearDiagnostics}
            disabled={entries.length === 0}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={t.diagnosticsClear}
          >
            <LineIcon name="x" size={20} color={entries.length === 0 ? theme.dim : theme.error} />
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        {entries.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <Text style={[styles.emptyText, { color: theme.muted }]}>{t.diagnosticsEmpty}</Text>
          </View>
        ) : entries.map((entry) => (
          <View key={entry.id} style={[styles.entry, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.entryHeader}>
              <Text style={[styles.kind, { color: theme.accent }]}>{kindLabel(entry.kind)}</Text>
              <Text style={[styles.timestamp, { color: theme.dim }]}>
                {new Date(entry.timestamp).toLocaleString(lang === "zh" ? "zh-CN" : "en-US")}
              </Text>
            </View>
            <Text style={[styles.source, { color: theme.muted }]}>{entry.source}</Text>
            <Text style={[styles.message, { color: theme.text }]}>{entry.message}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1 },
    header: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", paddingHorizontal: MIUIX_SPACE.md },
    iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    headerTitleWrap: { flex: 1, paddingHorizontal: MIUIX_SPACE.sm },
    headerTitle: { fontSize: MIUIX_TYPE.title4, fontWeight: "700" },
    headerSummary: { fontSize: MIUIX_TYPE.footnote2, marginTop: 2 },
    content: { padding: MIUIX_SPACE.md, gap: MIUIX_SPACE.sm, paddingBottom: MIUIX_SPACE.xxl },
    empty: { borderWidth: 1, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.xl, alignItems: "center" },
    emptyText: { fontSize: MIUIX_TYPE.body2 },
    entry: { borderWidth: 1, borderRadius: MIUIX_RADIUS.sm, padding: MIUIX_SPACE.md },
    entryHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: MIUIX_SPACE.sm },
    kind: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "700" },
    timestamp: { fontSize: MIUIX_TYPE.footnote2 },
    source: { fontSize: MIUIX_TYPE.footnote2, marginTop: MIUIX_SPACE.xs },
    message: { fontSize: MIUIX_TYPE.body2, lineHeight: 20, marginTop: MIUIX_SPACE.xs },
  });
}

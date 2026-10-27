import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LineIcon } from "../src/components/LineIcon";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";
import { useI18n } from "../src/i18n";

interface HerdrSettingsSnapshot {
  settings: { runtime: "auto" | "pi" | "pi-bolt"; resumeHistory: boolean; autoCleanupSpace: boolean };
  favorites: string[];
  launchedSpaces: Array<{ paneId: string; workspaceId?: string; label?: string; cwd: string; launchedAt: string }>;
}

export default function HerdrDirectoriesScreen() {
  const { getHerdrSettings, updateHerdrSettings, supportsHerdrSettings } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [favorites, setFavorites] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = (await getHerdrSettings()) as { result?: HerdrSettingsSnapshot } & HerdrSettingsSnapshot;
      const data = snapshot.result ?? snapshot;
      setFavorites(Array.isArray(data.favorites) ? data.favorites : []);
      setMessage(null);
    } catch {
      setMessage(t.herdrUnavailable);
    } finally {
      setLoading(false);
    }
  }, [getHerdrSettings, t.herdrUnavailable]);

  useEffect(() => {
    if (!supportsHerdrSettings) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh, supportsHerdrSettings]);

  /** 乐观更新；失败回滚到服务端快照，不让本地与 Host 漂移。 */
  const commit = useCallback(async (next: string[], successKey: "added" | "removed") => {
    const previous = favorites;
    setFavorites(next);
    setBusy(true);
    try {
      await updateHerdrSettings({ reorderFavorites: next });
      setMessage(successKey === "added" ? t.herdrFavoriteDirsAdd : t.herdrFavoriteDirsRemove);
    } catch {
      setFavorites(previous);
      setMessage(t.herdrFailed);
    } finally {
      setBusy(false);
    }
  }, [favorites, updateHerdrSettings, t.herdrFavoriteDirsAdd, t.herdrFavoriteDirsRemove, t.herdrFailed]);

  const add = useCallback(async (path: string) => {
    const normalized = path.trim();
    if (!normalized.startsWith("/") || favorites.includes(normalized)) return;
    await commit([...favorites, normalized], "added");
  }, [commit, favorites]);

  const remove = useCallback(async (path: string) => {
    await commit(favorites.filter((entry) => entry !== path), "removed");
  }, [commit, favorites]);

  const move = useCallback(async (path: string, delta: number) => {
    const from = favorites.indexOf(path);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= favorites.length) return;
    const next = [...favorites];
    next[from] = favorites[to]!;
    next[to] = favorites[from]!;
    await commit(next, "removed");
  }, [commit, favorites]);

  if (!supportsHerdrSettings) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Header theme={theme} title={t.herdrFavoriteDirs} />
        <View style={styles.center}>
          <Text style={{ color: theme.muted, fontSize: 13 }}>{t.herdrUnavailable}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Header theme={theme} title={t.herdrFavoriteDirs} />
      <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={t.herdrFavoriteDirsPrompt}
            placeholderTextColor={theme.dim}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onSubmitEditing={() => void add(draft).then(() => setDraft(""))}
          />
          <TouchableOpacity
            onPress={() => void add(draft).then(() => setDraft(""))}
            disabled={busy || !draft.trim().startsWith("/")}
            accessibilityRole="button"
            accessibilityLabel={t.herdrFavoriteDirsAdd}
            style={[styles.addButton, { backgroundColor: theme.buttonPrimary, opacity: busy || !draft.trim().startsWith("/") ? 0.5 : 1 }]}
          >
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.addButtonText}>{t.herdrFavoriteDirsAdd}</Text>}
          </TouchableOpacity>
        </View>

        {message ? <Text style={[styles.message, { color: theme.muted }]}>{message}</Text> : null}

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : (
          <FlatList
            data={favorites}
            keyExtractor={(item) => item}
            contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={{ color: theme.muted, fontSize: 13, textAlign: "center" }}>{t.herdrFavoriteDirsEmpty}</Text>
              </View>
            }
            renderItem={({ item }) => (
              <View style={[styles.row, { borderColor: theme.border, backgroundColor: theme.cardBg }]}>
                <Text style={[styles.path, { color: theme.text }]} numberOfLines={1}>{item}</Text>
                <View style={styles.rowActions}>
                  <TouchableOpacity
                    onPress={() => void move(item, -1)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={t.herdrFavoriteDirsCurrent}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <LineIcon name="chevronRight" size={16} color={theme.muted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void move(item, 1)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={t.herdrFavoriteDirsRemove}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <LineIcon name="arrowDown" size={16} color={theme.muted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => void remove(item)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={t.herdrFavoriteDirsRemove}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <LineIcon name="x" size={16} color={theme.error} />
                  </TouchableOpacity>
                </View>
              </View>
            )}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

function Header({ theme, title }: { theme: ReturnType<typeof useTheme>["theme"]; title: string }) {
  return (
    <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
      <View style={[localStyles.header, { borderBottomColor: theme.border, backgroundColor: theme.headerBg }]}>
        <TouchableOpacity onPress={() => router.back()} style={localStyles.backBtn} accessibilityRole="button" accessibilityLabel="back">
          <LineIcon name="arrowLeft" size={20} color={theme.text} strokeWidth={2.4} />
        </TouchableOpacity>
        <Text style={[localStyles.headerTitle, { color: theme.text }]} numberOfLines={1}>{title}</Text>
        <View style={{ width: 26 }} />
      </View>
    </SafeAreaView>
  );
}

const localStyles = StyleSheet.create({
  header: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { padding: 6, marginRight: 8 },
  headerTitle: { fontSize: 16, fontWeight: "600", flex: 1 },
});

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    inputRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 12, alignItems: "center" },
    input: {
      flex: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 9,
      fontSize: 13,
      backgroundColor: theme.inputBg,
    },
    addButton: { borderRadius: 10, paddingHorizontal: 14, minHeight: 38, alignItems: "center", justifyContent: "center" },
    addButtonText: { color: "#fff", fontWeight: "700", fontSize: 12 },
    message: { fontSize: 11, paddingHorizontal: 16, paddingTop: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
    path: { flex: 1, fontSize: 13, fontFamily: "monospace" },
    rowActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  });
}

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
import { CommandFailedError } from "@maestro-mobile/mobile-sdk";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";
import { useI18n } from "../src/i18n";

function cwdName(cwd: string): string { return cwd.split("/").filter(Boolean).pop() ?? cwd; }

interface HerdrSettingsSnapshot {
  settings: { runtime: "auto" | "pi" | "pi-bolt"; resumeHistory: boolean; autoCleanupSpace: boolean };
  favorites: string[];
  launchedSpaces: Array<{ paneId: string; cwd: string; launchedAt: string }>;
}

interface HerdrStatusSnapshot {
  status: "available" | "not_installed" | "not_running" | "incompatible" | "degraded";
  running: boolean;
  version?: string;
  runtimes?: { pi: boolean; piBolt: boolean };
}

type LaunchState =
  | { kind: "idle" }
  | { kind: "launching" }
  | { kind: "ready"; paneId?: string; runtime?: string }
  | { kind: "failed"; message: string }
  | { kind: "unknown"; message: string };

export default function HerdrNewSessionScreen() {
  const { getHerdrSettings, getHerdrStatus, launchPiSession, supportsHerdrLaunch, isConnected } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [favorites, setFavorites] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<"auto" | "pi" | "pi-bolt">("auto");
  const [piBoltAvailable, setPiBoltAvailable] = useState(false);
  const [cwd, setCwd] = useState("");
  const [label, setLabel] = useState("");
  const [launch, setLaunch] = useState<LaunchState>({ kind: "idle" });

  useEffect(() => {
    void (async () => {
      try {
        const snapshot = (await getHerdrSettings()) as { result?: HerdrSettingsSnapshot } & HerdrSettingsSnapshot;
        const data = snapshot.result ?? snapshot;
        setFavorites(Array.isArray(data.favorites) ? data.favorites : []);
        setRuntime(data.settings?.runtime ?? "auto");
      } catch {
        // Host 不可用时保留手输兜底路径。
      }
      try {
        const status = (await getHerdrStatus()) as { result?: HerdrStatusSnapshot } & HerdrStatusSnapshot;
        const value = status.result ?? status;
        setPiBoltAvailable(value.runtimes?.piBolt === true);
      } catch {
        // 探测失败视为无 bolt，运行时展示退回 Pi。
      }
    })();
  }, [getHerdrSettings, getHerdrStatus]);

  const start = useCallback(async () => {
    const target = cwd.trim();
    if (!target || launch.kind === "launching" || !isConnected) return;
    setLaunch({ kind: "launching" });
    try {
      const result = (await launchPiSession(target, label.trim() || undefined, { runtime })) as {
        result?: { status?: string; paneId?: string; runtime?: string };
        status?: string;
        paneId?: string;
        runtime?: string;
      };
      const data = result.result ?? result;
      if (data.status === "ready") {
        setLaunch({ kind: "ready", paneId: data.paneId, runtime: data.runtime });
        return;
      }
      if (data.status === "failed") {
        setLaunch({ kind: "failed", message: t.herdrFailed });
        return;
      }
      // unknown：不自动重试，与历史 smoke 语义一致
      setLaunch({ kind: "unknown", message: t.herdrUnknown });
    } catch (cause) {
      // Host 对非 ready 结果回 ok:false，SDK 会抛 CommandFailedError；
      // 必须区分「确定失败（可重试）」与「结果未知（禁止重试）」，否则会把 unknown 误当成 failed。
      if (cause instanceof CommandFailedError) {
        if (cause.status === "failed") setLaunch({ kind: "failed", message: t.herdrFailed });
        else setLaunch({ kind: "unknown", message: t.herdrUnknown });
        return;
      }
      setLaunch({ kind: "failed", message: t.herdrFailed });
    }
  }, [cwd, label, launch.kind, isConnected, launchPiSession, runtime, t.herdrFailed, t.herdrUnknown]);

  const disabled = !isConnected || !supportsHerdrLaunch || launch.kind === "launching" || !cwd.trim();

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
        <View style={[styles.header, { borderBottomColor: theme.border, backgroundColor: theme.headerBg }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="back">
            <LineIcon name="arrowLeft" size={20} color={theme.text} strokeWidth={2.4} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>{t.herdrNewSessionTitle}</Text>
          <View style={{ width: 26 }} />
        </View>
      </SafeAreaView>

      <SafeAreaView style={{ flex: 1 }} edges={["bottom"]}>
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.dim }]}>{t.herdrRuntime}</Text>
          <View style={[styles.segWrap, { backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg }]}>
            {([
              { key: "auto" as const, label: t.herdrRuntimeAuto },
              { key: "pi-bolt" as const, label: t.herdrRuntimePiBolt },
              { key: "pi" as const, label: t.herdrRuntimePi },
            ]).map((item) => {
              const active = runtime === item.key;
              const locked = item.key !== "pi" && !piBoltAvailable;
              return (
                <TouchableOpacity
                  key={item.key}
                  disabled={locked}
                  onPress={() => setRuntime(item.key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: locked }}
                  accessibilityLabel={item.label}
                  style={[styles.segItem, active && { backgroundColor: theme.accent }, locked && { opacity: 0.4 }]}
                >
                  <Text style={[styles.segText, { color: active ? "#FFFFFF" : theme.muted }, active && { fontWeight: "700" }]}>{item.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {!piBoltAvailable ? <Text style={[styles.hint, { color: theme.muted }]}>{t.herdrRuntimePinned}</Text> : null}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.dim }]}>{t.herdrNewSessionPick}</Text>
          <FlatList
            data={favorites}
            keyExtractor={(item) => item}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingRight: 16 }}
            ListEmptyComponent={<Text style={[styles.hint, { color: theme.muted }]}>{t.herdrFavoriteDirsEmpty}</Text>}
            renderItem={({ item }) => {
              const active = cwd === item;
              return (
                <TouchableOpacity
                  onPress={() => setCwd(item)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.chip, { borderColor: active ? theme.accent : theme.border, backgroundColor: theme.cardBg }]}
                >
                  <LineIcon name="folder" size={14} color={active ? theme.accent : theme.muted} />
                  <Text style={[styles.chipText, { color: active ? theme.text : theme.muted }]} numberOfLines={1}>{cwdName(item)}</Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.dim }]}>{t.herdrNewSessionCustomCwd}</Text>
          <TextInput
            style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
            value={cwd}
            onChangeText={setCwd}
            placeholder={t.herdrFavoriteDirsPrompt}
            placeholderTextColor={theme.dim}
            autoCapitalize="none"
            autoCorrect={false}
            editable={launch.kind !== "launching"}
          />
          <TextInput
            style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg, marginTop: 8 }]}
            value={label}
            onChangeText={setLabel}
            placeholder={t.herdrNewSessionLabel}
            placeholderTextColor={theme.dim}
            autoCapitalize="none"
            editable={launch.kind !== "launching"}
          />
        </View>

        <View style={styles.section}>
          <TouchableOpacity
            onPress={() => void start()}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t.herdrNewSessionLaunch}
            style={[styles.launchButton, { backgroundColor: theme.buttonPrimary, opacity: disabled ? 0.5 : 1 }]}
          >
            {launch.kind === "launching" ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.launchButtonText}>{t.herdrNewSessionLaunch}</Text>}
          </TouchableOpacity>

          {launch.kind === "ready" ? (
            <Text style={[styles.statusText, { color: theme.success }]}>
              {t.herdrReady}{launch.paneId ? ` · ${launch.paneId}` : ""}{launch.runtime ? ` · ${launch.runtime}` : ""}
            </Text>
          ) : null}
          {launch.kind === "failed" ? (
            <View style={styles.statusBlock}>
              <Text style={[styles.statusText, { color: theme.error }]}>{launch.message}</Text>
              <TouchableOpacity onPress={() => setLaunch({ kind: "idle" })} accessibilityRole="button">
                <Text style={[styles.retryText, { color: theme.accent }]}>{t.retry}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {launch.kind === "unknown" ? (
            <Text style={[styles.statusText, { color: theme.warning }]}>{launch.message}</Text>
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    header: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
    backBtn: { padding: 6, marginRight: 8 },
    headerTitle: { fontSize: 16, fontWeight: "600", flex: 1 },
    section: { paddingHorizontal: 16, paddingTop: 14 },
    sectionLabel: { fontSize: 10, fontWeight: "600", marginBottom: 8 },
    hint: { fontSize: 11, marginTop: 6 },
    segWrap: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 4 },
    segItem: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
    segText: { fontSize: 12, fontWeight: "600" },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, maxWidth: 200 },
    chipText: { fontSize: 12, fontFamily: "monospace" },
    input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, fontSize: 13 },
    launchButton: { borderRadius: 10, minHeight: 44, alignItems: "center", justifyContent: "center" },
    launchButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
    statusText: { fontSize: 12, marginTop: 10 },
    statusBlock: { gap: 6 },
    retryText: { fontSize: 12, fontWeight: "700" },
  });
}

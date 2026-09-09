import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router, useNavigation } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { QRPairScanner } from "../src/components/QRPairScanner";
import { LineIcon } from "../src/components/LineIcon";
import { isPairingFlowActive, resolvePairingCandidate, requiresCandidateSelection, shouldBlockPairingBack } from "../src/pair-scan-logic";
import { extractPairing, type PairingInfo } from "../src/pairing";
import { persistPairedHost } from "../src/paired-hosts";
import { useHost } from "../src/store";
import { MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE, useTheme } from "../src/theme";

type ScanState = "scanning" | "exchanging" | "selecting" | "saving" | "error";

const isIp = (value: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value);

function requestSignal(parent: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  const abort = () => {
    clearTimeout(timeout);
    controller.abort();
  };
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export default function PairScanScreen() {
  const { theme } = useTheme();
  const { connect } = useHost();
  const navigation = useNavigation();
  const styles = makeStyles();
  const scanLocked = useRef(false);
  const mountedRef = useRef(true);
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef(new AbortController());
  const navigationAllowedRef = useRef(false);
  const commitInProgressRef = useRef(false);
  const isActive = useCallback(() => isPairingFlowActive(mountedRef.current, cancelledRef.current, abortControllerRef.current.signal.aborted), []);

  useEffect(() => () => {
    mountedRef.current = false;
    cancelledRef.current = true;
    abortControllerRef.current.abort();
  }, []);
  const [state, setState] = useState<ScanState>("scanning");
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const removeNavigationGuard = navigation.addListener("beforeRemove", (event) => {
      if (!commitInProgressRef.current && !shouldBlockPairingBack(state, navigationAllowedRef.current)) return;
      if (navigationAllowedRef.current) return;
      event.preventDefault();
    });
    const hardwareBack = BackHandler.addEventListener("hardwareBackPress", () => (
      !navigationAllowedRef.current
      && (commitInProgressRef.current || shouldBlockPairingBack(state, false))
    ));
    return () => {
      removeNavigationGuard();
      hardwareBack.remove();
    };
  }, [navigation, state]);

  useEffect(() => {
    const removeFocus = navigation.addListener("focus", () => {
      if (!commitInProgressRef.current) reset();
    });
    const removeBlur = navigation.addListener("blur", () => {
      if (commitInProgressRef.current) return;
      // 让离开页面时的异步换码请求失效；重新进入时 focus 会建立全新扫描状态。
      cancelledRef.current = true;
      abortControllerRef.current.abort();
      scanLocked.current = false;
      setPairing(null);
      setSelectedIp(null);
      setError("");
      setState("scanning");
    });
    return () => {
      removeFocus();
      removeBlur();
    };
  }, [navigation]);

  const saveAndConnect = useCallback(async (info: PairingInfo) => {
    if (!isActive()) return;
    commitInProgressRef.current = true;
    setState("saving");
    try {
      await persistPairedHost({ name: info.displayHost, hostUrl: info.hostUrl, token: info.token ?? "" });
      if (!isActive()) return;
      connect(info.hostUrl, info.token);
      if (!isActive()) return;
      navigationAllowedRef.current = true;
      commitInProgressRef.current = false;
      router.replace("/host-sessions");
    } catch (cause) {
      commitInProgressRef.current = false;
      if (!isActive()) return;
      setError(cause instanceof Error ? cause.message : "保存配对信息失败");
      setState("error");
    }
  }, [connect, isActive]);

  const processPairing = useCallback(async (info: PairingInfo) => {
    if (!isActive()) return;
    setPairing(info);
    if (requiresCandidateSelection(info)) {
      setState("selecting");
      return;
    }
    const resolved = resolvePairingCandidate(info);
    if (!resolved) {
      setError("二维码中没有可用的 Host 地址，请重新生成二维码");
      setState("error");
      return;
    }
    await saveAndConnect(resolved);
  }, [isActive, saveAndConnect]);

  const exchangeShortCode = useCallback(async (info: PairingInfo) => {
    setState("exchanging");
    const results = await Promise.all(info.candidateIps.map(async (ip) => {
      try {
        const response = await fetch(`http://${ip}:${info.port}/api/pair-short?code=${encodeURIComponent(info.shortCode!)}`, { signal: requestSignal(abortControllerRef.current.signal) });
        if (!isActive() || !response.ok) return null;
        const data = (await response.json()) as { token?: string; ips?: string[] };
        if (!isActive()) return null;
        return typeof data.token === "string" ? data : null;
      } catch {
        return null;
      }
    }));
    if (!isActive()) return;
    const hit = results.find((result) => result !== null);
    if (!hit) {
      setError("配对码换取失败（所有地址均不可达或已过期），请确认手机与 PC 在同一网络");
      setState("error");
      return;
    }
    const ips = (hit.ips ?? []).filter(isIp);
    await processPairing({ ...info, token: hit.token, candidateIps: ips.length > 0 ? ips : info.candidateIps });
  }, [isActive, processPairing]);

  const handleScanned = useCallback((raw: string) => {
    if (scanLocked.current || state !== "scanning") return;
    scanLocked.current = true;
    const info = extractPairing(raw);
    if (!info) {
      setError("无法解析此二维码。请在 PC 终端重新执行 /maestro-mobile qr 获取新二维码。");
      setState("error");
      return;
    }
    if (info.shortCode) void exchangeShortCode(info);
    else void processPairing(info);
  }, [exchangeShortCode, processPairing, state]);

  const cancelAndBack = () => {
    if (commitInProgressRef.current || shouldBlockPairingBack(state, navigationAllowedRef.current)) return;
    if (state === "selecting" || state === "error" || state === "exchanging") {
      reset();
      return;
    }
    cancelledRef.current = true;
    abortControllerRef.current.abort();
    router.back();
  };

  function reset() {
    abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    cancelledRef.current = false;
    navigationAllowedRef.current = false;
    commitInProgressRef.current = false;
    setPairing(null);
    setSelectedIp(null);
    setError("");
    scanLocked.current = false;
    setState("scanning");
  }

  const continueWithSelection = () => {
    if (!pairing) return;
    const resolved = resolvePairingCandidate(pairing, selectedIp ?? undefined);
    if (resolved) void saveAndConnect(resolved);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]} edges={["top", "bottom"]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={cancelAndBack} disabled={state === "saving"} accessibilityRole="button" accessibilityLabel="返回会话页" accessibilityState={{ disabled: state === "saving" }} style={[styles.iconButton, state === "saving" && styles.disabled]}>
          <LineIcon name="collapse" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>扫描配对二维码</Text>
        <View style={styles.iconButton} />
      </View>

      {state === "scanning" ? (
        <QRPairScanner disabled={false} onScanned={handleScanned} onError={(message) => { setError(message); setState("error"); }} />
      ) : state === "selecting" && pairing ? (
        <View style={styles.content}>
          <Text style={[styles.heading, { color: theme.text }]}>选择要连接的地址</Text>
          <Text style={[styles.hint, { color: theme.onBackgroundVariant ?? theme.muted }]}>请选择一个地址，然后点下一步。</Text>
          <ScrollView contentContainerStyle={styles.list}>
            {pairing.candidateIps.map((ip) => {
              const selected = selectedIp === ip;
              return (
                <TouchableOpacity
                  key={ip}
                  style={[styles.candidate, { borderColor: selected ? theme.accent : theme.border, backgroundColor: selected ? theme.secondaryContainer : theme.cardBg }]}
                  onPress={() => setSelectedIp(ip)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`选择 ${ip}:${pairing.port}`}
                >
                  <View style={[styles.radio, { borderColor: selected ? theme.accent : theme.muted }]}>{selected ? <View style={[styles.radioFill, { backgroundColor: theme.accent }]} /> : null}</View>
                  <View style={styles.candidateMeta}>
                    <Text style={[styles.candidateText, { color: theme.text }]}>{ip}:{pairing.port}</Text>
                    <Text style={[styles.candidateType, { color: theme.onBackgroundVariant ?? theme.muted }]}>{addressType(ip)}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: theme.buttonPrimary, opacity: selectedIp ? 1 : 0.45 }]}
            disabled={!selectedIp}
            onPress={continueWithSelection}
            accessibilityRole="button"
            accessibilityLabel="下一步"
            accessibilityState={{ disabled: !selectedIp }}
          >
            <Text style={styles.primaryButtonText}>下一步</Text>
          </TouchableOpacity>
        </View>
      ) : state === "error" ? (
        <View style={styles.center}>
          <Text style={[styles.heading, { color: theme.error }]}>配对失败</Text>
          <Text style={[styles.message, { color: theme.onBackgroundVariant ?? theme.muted }]}>{error}</Text>
          <TouchableOpacity style={[styles.primaryButton, { backgroundColor: theme.buttonPrimary }]} onPress={reset} accessibilityRole="button" accessibilityLabel="重新扫码">
            <Text style={styles.primaryButtonText}>重新扫码</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.heading, { color: theme.text }]}>{stateLabel(state)}</Text>
          <Text style={[styles.message, { color: theme.onBackgroundVariant ?? theme.muted }]}>{state === "saving" ? "正在保存，请勿退出" : "请保持此页面打开"}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

function stateLabel(state: ScanState): string {
  if (state === "exchanging") return "正在换取配对凭证…";
  if (state === "saving") return "正在保存并连接…";
  return "正在处理…";
}

function addressType(ip: string): string {
  if (ip.startsWith("100.")) return "VPN";
  if (/^(198\.18|198\.19)\./.test(ip)) return "代理";
  if (ip.startsWith("127.")) return "本机";
  return "局域网";
}

function makeStyles() {
  return StyleSheet.create({
    container: { flex: 1 },
    header: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: MIUIX_SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth },
    iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    disabled: { opacity: 0.35 },
    title: { fontSize: MIUIX_TYPE.body1, fontWeight: "700" },
    content: { flex: 1, padding: MIUIX_SPACE.lg },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: MIUIX_SPACE.xl, gap: MIUIX_SPACE.md },
    heading: { fontSize: MIUIX_TYPE.title2, fontWeight: "700", textAlign: "center" },
    hint: { fontSize: MIUIX_TYPE.footnote1, lineHeight: 19, marginTop: MIUIX_SPACE.xs },
    message: { fontSize: MIUIX_TYPE.body2, lineHeight: 22, textAlign: "center" },
    list: { paddingVertical: MIUIX_SPACE.lg, gap: MIUIX_SPACE.sm },
    candidate: { minHeight: 64, flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md, gap: MIUIX_SPACE.md },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
    radioFill: { width: 10, height: 10, borderRadius: 5 },
    candidateMeta: { flex: 1 },
    candidateText: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    candidateType: { fontSize: MIUIX_TYPE.footnote2, marginTop: 2 },
    primaryButton: { minHeight: 48, minWidth: 180, borderRadius: MIUIX_RADIUS.md, alignItems: "center", justifyContent: "center", paddingHorizontal: MIUIX_SPACE.xl },
    primaryButtonText: { color: "#fff", fontSize: MIUIX_TYPE.body2, fontWeight: "700" },
  });
}

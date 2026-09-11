/**
 * HostConnectCard — HyperOS 控制中心式连接卡（Miuix 设计稿 screenSessions 对齐）
 *
 * v2 连接体验（用户需求 0.2.0）：
 * - 扫码配对：点「扫码配对」调相机扫 PC `/maestro-mobile qr` 二维码，地址+token 一次填入；
 *   手填 token 输入框移除（地址输入保留，便于直连本机调试）。
 * - 多 Host 实例：已配对的 host 存 AsyncStorage 列表，卡片头部下拉切换，切换即连。
 * - 状态 pill：已连接 / 连接中 / 重连中 / 未连接 / token 错误（authFailed 停止重连时）。
 */
import React, { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Modal } from "react-native";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../theme";
import { useHost } from "../store";
import { LineIcon } from "./LineIcon";
import { MiuixSwitch } from "./MiuixSwitch";
import { loadPairedHosts, savePairedHosts, rememberRemovedHost, forgetRemovedHost, type PairedHost } from "../paired-hosts";

export function HostConnectCard({ hostUrl, token, onHostUrlChange, onTokenChange }: {
  hostUrl: string;
  token: string;
  onHostUrlChange: (v: string) => void;
  onTokenChange: (v: string) => void;
}) {
  const { theme } = useTheme();
  const router = useRouter();
  const { isConnected, connectionState, connect, disconnect, lastError } = useHost();
  const [open, setOpen] = useState(false);
  // P3-5：keepAlive 接入真实语义 —— 关闭时不再自动重连；开启时（默认）断线自动重连。
  const [keepAlive, setKeepAlive] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);
  // 多 host 实例
  const [paired, setPaired] = useState<PairedHost[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [codeInputVisible, setCodeInputVisible] = useState(false);
  const [codeValue, setCodeValue] = useState("");
  const [codeHost, setCodeHost] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);

  useEffect(() => {
    void loadPairedHosts().then(setPaired);
  }, []);

  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected]);

  const busy = connectionState === "connecting" || connectionState === "reconnecting";
  const tokenError = connectionState === "disconnected" && !!lastError?.includes("token");
  const styles = makeStyles(theme);

  const doConnect = (url: string, tok: string) => {
    if (!url.trim()) return;
    connect(url.trim(), tok.trim() || undefined);
  };

  const handleKeepAliveChange = (v: boolean) => {
    setKeepAlive(v);
    if (!v) {
      if (isConnected || busy) disconnect();
    } else if (hostUrl.trim()) {
      doConnect(hostUrl, token);
    }
  };

  // P3-5：链路延迟测真实 host 端点（/api/status），而非 Metro dev server。
  React.useEffect(() => {
    if (!isConnected || !hostUrl) { setLatency(null); return; }
    let alive = true;
    const httpBase = hostUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
    const statusUrl = `${httpBase}/api/status${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const tick = () => {
      const t0 = Date.now();
      void fetch(statusUrl)
        .then((res) => {
          if (alive && res.ok) setLatency(Math.max(1, Date.now() - t0));
          else if (alive) setLatency(null);
        })
        .catch(() => {
          if (alive) setLatency(null);
        });
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [isConnected, hostUrl, token]);

  /** 配对码手动换码：GET /api/pair-short?code= → token+ips → 连接首选可达地址 */
  const submitCode = async () => {
    setCodeError(null);
    setCodeBusy(true);
    try {
      const host = codeHost.trim();
      const res = await fetch(`http://${host}:4739/api/pair-short?code=${encodeURIComponent(codeValue)}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(res.status === 404 ? "配对码无效或已过期，请在 PC 重新执行 /maestro-mobile qr" : `host 返回 ${res.status}`);
      const d = (await res.json()) as { token: string; ips: string[]; port: number };
      const ip = (d.ips ?? [])[0] ?? host;
      setCodeInputVisible(false);
      handlePaired({ hostUrl: `ws://${ip}:${d.port ?? 4739}/ws`, token: d.token, displayHost: `${ip}:${d.port ?? 4739}` });
    } catch (e) {
      setCodeError(e instanceof Error ? e.message : "换取失败，请检查 PC 地址与网络");
    } finally {
      setCodeBusy(false);
    }
  };

  /** 扫码/选择配对成功：保存到配对列表并连接 */
  const handlePaired = (info: { hostUrl: string; token?: string; displayHost: string }) => {
    onHostUrlChange(info.hostUrl);
    onTokenChange(info.token ?? "");
    void forgetRemovedHost(info.hostUrl); // 重新配对成功：解除删除记忆
    void savePairedHosts([
      { name: info.displayHost, hostUrl: info.hostUrl, token: info.token ?? "", pairedAt: new Date().toISOString() },
      ...paired.filter((p) => p.hostUrl !== info.hostUrl),
    ].slice(0, 8))
      .then(() => loadPairedHosts())
      .then(setPaired);
    doConnect(info.hostUrl, info.token ?? "");
  };

  const switchTo = (h: PairedHost) => {
    setPickerOpen(false);
    if (isConnected || busy) disconnect();
    onHostUrlChange(h.hostUrl);
    onTokenChange(h.token);
    doConnect(h.hostUrl, h.token);
  };

  const removePaired = (h: PairedHost) => {
    const next = paired.filter((p) => p.hostUrl !== h.hostUrl);
    setPaired(next);
    void savePairedHosts(next);
    void rememberRemovedHost(h.hostUrl); // 幽灵修复：删除过的地址不再被 legacy 导入重建
  };

  const statusColor = isConnected ? theme.success : tokenError ? theme.error : busy ? theme.accent : theme.error;
  const statusText = isConnected ? "已连接" : tokenError ? "token 错误" : busy ? (connectionState === "connecting" ? "连接中" : "重连中") : "未连接";
  const activePaired = paired.find((p) => p.hostUrl === hostUrl);

  return (
    <View style={[styles.card, { backgroundColor: theme.tertiaryContainer ?? theme.cardBg }]} accessibilityRole="button" accessibilityLabel={`Host 连接卡，${statusText}`}>
      <TouchableOpacity style={styles.head} onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={open ? "收起连接控制中心" : "展开连接控制中心"}>
        <View style={[styles.iconWrap, { backgroundColor: theme.surfaceVariant }]}>
          <LineIcon name="radio" size={20} color={theme.onTertiaryContainer ?? theme.accent} />
        </View>
        <View style={styles.meta}>
          <Text style={[styles.name, { color: theme.text }]}>通信与配对中枢</Text>
          <Text style={[styles.sub, { color: theme.onBackgroundVariant ?? theme.muted }]} numberOfLines={1}>
            {hostUrl || "扫码配对或输入 ws://<PC-IP>:4739/ws"}
          </Text>
        </View>
        <View style={[styles.pill, { backgroundColor: theme.surfaceVariant }]}>
          <View style={[styles.led, { backgroundColor: statusColor }]} />
          <Text style={[styles.pillText, { color: theme.text }]}>{statusText}</Text>
        </View>
        <LineIcon name={open ? "collapse" : "expand"} size={16} color={theme.onTertiaryContainer ?? theme.muted} />
      </TouchableOpacity>

      {open && (
        <View style={styles.panel}>
          {/* 扫码配对主按钮 + 地址输入（token 由扫码带入，不再手填） */}
          <TouchableOpacity
            style={[styles.pairBtn, { backgroundColor: theme.buttonPrimary }]}
            onPress={() => router.push("/pair-scan")}
            accessibilityRole="button"
            accessibilityLabel="扫码配对"
          >
            <LineIcon name="image" size={16} color="#fff" />
            <Text style={styles.pairBtnText}>  扫码配对（PC 执行 /maestro-mobile qr）</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.codeBtn, { backgroundColor: theme.secondaryContainer ?? theme.cardBg }]}
            onPress={() => setCodeInputVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="输入配对码"
          >
            <Text style={[styles.codeBtnText, { color: theme.text }]}>输入配对码（相机不可用时）</Text>
          </TouchableOpacity>

          <Text style={[styles.label, { color: theme.onBackgroundVariant ?? theme.muted }]}>Host 地址（可手动输入）</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.surfaceVariant, color: theme.text, borderColor: theme.outline ?? theme.border }]}
            value={hostUrl}
            onChangeText={onHostUrlChange}
            placeholder="ws://<PC-IP>:4739/ws"
            placeholderTextColor={theme.onBackgroundVariant ?? theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onSubmitEditing={() => doConnect(hostUrl, token)}
          />

          {/* 多 Host 实例切换 */}
          {paired.length > 0 && (
            <TouchableOpacity
              style={[styles.row, { alignSelf: "flex-start" }]}
              onPress={() => setPickerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`切换 Host（${paired.length} 个已配对）`}
            >
              <LineIcon name="plan" size={15} color={theme.accent} />
              <Text style={[styles.rowLabel, { color: theme.accent }]}>  已配对 {paired.length} 台 · {activePaired?.name ?? "未选择"}</Text>
            </TouchableOpacity>
          )}

          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={[styles.rowLabel, { color: theme.text }]}>保持连接</Text>
              <Text style={[styles.rowSub, { color: theme.onBackgroundVariant ?? theme.muted }]}>断线自动重连 WebSocket</Text>
            </View>
            <MiuixSwitch value={keepAlive} onValueChange={handleKeepAliveChange} accessibilityLabel="保持连接" />
          </View>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.text }]}>链路延迟</Text>
            <View style={styles.latency}>
              <View style={[styles.led, { backgroundColor: latency ? theme.success : theme.onBackgroundVariant ?? theme.muted }]} />
              <Text style={[styles.latencyText, { color: theme.text }]}>{latency ? `${latency} ms` : "—"}</Text>
            </View>
          </View>
          {isConnected ? (
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.secondaryContainer ?? theme.cardBg }]}
              onPress={disconnect}
              accessibilityRole="button"
              accessibilityLabel="断开连接"
            >
              <Text style={[styles.btnText, { color: theme.error }]}>断开连接</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.buttonPrimary, opacity: busy ? 0.6 : 1 }]}
              onPress={() => doConnect(hostUrl, token)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="重新连接"
              accessibilityState={{ disabled: busy, busy }}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <LineIcon name="collapse" size={16} color="#fff" strokeWidth={2} />
                  <Text style={styles.btnText}>  连接</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {lastError ? <Text style={[styles.errorText, { color: tokenError ? theme.error : theme.muted }]}>{lastError}</Text> : null}
        </View>
      )}

      {/* 配对码手动输入弹层（相机不可用兜底：PC /maestro-mobile qr 通知里有 8 位码） */}
      <Modal visible={codeInputVisible} transparent animationType="fade" onRequestClose={() => setCodeInputVisible(false)}>
        <View style={[styles.codeMask, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
          <View style={[styles.codeSheet, { backgroundColor: theme.cardBg }]}>
            <Text style={[styles.codeTitle, { color: theme.text }]}>输入配对码</Text>
            <Text style={[styles.codeHint, { color: theme.onBackgroundVariant ?? theme.muted }]}>
              PC 执行 /maestro-mobile qr 后，通知里显示 8 位配对码（5 分钟有效）
            </Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.surfaceVariant, color: theme.text, borderColor: theme.border }]}
              value={codeValue}
              onChangeText={(t) => setCodeValue(t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
              placeholder="如 AB3D5K7M"
              placeholderTextColor={theme.onBackgroundVariant ?? theme.muted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, { backgroundColor: theme.surfaceVariant, color: theme.text, borderColor: theme.border }]}
              value={codeHost}
              onChangeText={setCodeHost}
              placeholder="PC 地址，如 192.168.1.5"
              placeholderTextColor={theme.onBackgroundVariant ?? theme.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
            />
            {codeError ? <Text style={[styles.errorText, { color: theme.error }]}>{codeError}</Text> : null}
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.buttonPrimary, opacity: codeBusy || codeValue.length < 6 || !codeHost.trim() ? 0.5 : 1 }]}
              disabled={codeBusy || codeValue.length < 6 || !codeHost.trim()}
              onPress={() => void submitCode()}
              accessibilityRole="button"
              accessibilityLabel="用配对码连接"
            >
              <Text style={styles.btnText}>{codeBusy ? "换取中…" : "连接"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ alignItems: "center", paddingVertical: MIUIX_SPACE.md }} onPress={() => setCodeInputVisible(false)} accessibilityRole="button" accessibilityLabel="取消">
              <Text style={{ color: theme.muted }}>取消</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 已配对 Host 选择器 */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.pickerMask} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={[styles.pickerSheet, { backgroundColor: theme.cardBg }]}>
            <Text style={[styles.pickerTitle, { color: theme.text }]}>选择 Host</Text>
            {paired.map((h) => (
              <View key={h.hostUrl} style={[styles.pickerRow, { borderColor: theme.border }]}>
                <TouchableOpacity style={styles.pickerMain} onPress={() => switchTo(h)} accessibilityRole="button" accessibilityLabel={`连接 ${h.name}`}>
                  <View style={[styles.led, { backgroundColor: h.hostUrl === hostUrl && isConnected ? theme.success : theme.onBackgroundVariant ?? theme.muted }]} />
                  <View style={styles.pickerMeta}>
                    <Text style={[styles.pickerName, { color: theme.text }]}>{h.name}</Text>
                    <Text style={[styles.pickerSub, { color: theme.onBackgroundVariant ?? theme.muted }]} numberOfLines={1}>{h.hostUrl}</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => removePaired(h)} accessibilityRole="button" accessibilityLabel={`删除 ${h.name}`}>
                  <Text style={{ color: theme.error, fontWeight: "600" }}>删除</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={[styles.pickerAdd, { borderColor: theme.accent }]} onPress={() => { setPickerOpen(false); router.push("/pair-scan"); }} accessibilityRole="button" accessibilityLabel="扫码添加新 Host">
              <Text style={{ color: theme.accent, fontWeight: "600" }}>+ 扫码添加新 Host</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    card: {
      marginHorizontal: MIUIX_SPACE.lg,
      marginTop: MIUIX_SPACE.sm,
      marginBottom: MIUIX_SPACE.lg,
      borderRadius: 22,
      padding: MIUIX_SPACE.lg,
    },
    head: { flexDirection: "row", alignItems: "center", gap: 13 },
    iconWrap: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
    meta: { flex: 1, minWidth: 0 },
    name: { fontSize: MIUIX_TYPE.body1, fontWeight: "700" },
    sub: { fontSize: MIUIX_TYPE.footnote1, marginTop: 2 },
    pill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: MIUIX_RADIUS.pill, paddingHorizontal: 10, paddingVertical: 5 },
    led: { width: 8, height: 8, borderRadius: 4 },
    pillText: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "700" },
    panel: { marginTop: MIUIX_SPACE.lg },
    pairBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: MIUIX_RADIUS.md,
      minHeight: 44,
      marginBottom: MIUIX_SPACE.md,
    },
    pairBtnText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
    label: { fontSize: MIUIX_TYPE.footnote1, marginBottom: MIUIX_SPACE.xs },
    input: {
      borderRadius: MIUIX_RADIUS.md,
      borderWidth: 1,
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: MIUIX_SPACE.sm,
      fontSize: MIUIX_TYPE.body2,
      minHeight: 44,
      marginBottom: MIUIX_SPACE.sm,
    },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: MIUIX_SPACE.sm },
    rowMain: { flex: 1, marginRight: MIUIX_SPACE.md },
    rowLabel: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    rowSub: { fontSize: MIUIX_TYPE.footnote2, marginTop: 2 },
    latency: { flexDirection: "row", alignItems: "center", gap: 6 },
    latencyText: { fontSize: MIUIX_TYPE.footnote1, fontVariant: ["tabular-nums"] },
    btn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: MIUIX_RADIUS.md,
      minHeight: 44,
      marginTop: MIUIX_SPACE.sm,
    },
    btnText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
    errorText: { fontSize: MIUIX_TYPE.footnote1, marginTop: MIUIX_SPACE.sm },
    codeBtn: { borderRadius: MIUIX_RADIUS.md, minHeight: 40, alignItems: "center", justifyContent: "center", marginBottom: MIUIX_SPACE.md },
    codeBtnText: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
    codeMask: { flex: 1, justifyContent: "center", padding: MIUIX_SPACE.xl },
    codeSheet: { borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.lg },
    codeTitle: { fontSize: MIUIX_TYPE.body1, fontWeight: "700", marginBottom: MIUIX_SPACE.xs },
    codeHint: { fontSize: MIUIX_TYPE.footnote2, marginBottom: MIUIX_SPACE.md },
    // Host 选择器
    pickerMask: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
    pickerSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: MIUIX_SPACE.lg, paddingBottom: MIUIX_SPACE.xxl },
    pickerTitle: { fontSize: MIUIX_TYPE.body1, fontWeight: "700", marginBottom: MIUIX_SPACE.md },
    pickerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    pickerMain: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.md, flex: 1, marginRight: MIUIX_SPACE.md },
    pickerMeta: { flex: 1, minWidth: 0 },
    pickerName: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    pickerSub: { fontSize: MIUIX_TYPE.footnote2, marginTop: 2 },
    pickerAdd: { alignItems: "center", borderWidth: 1.5, borderStyle: "dashed", borderRadius: MIUIX_RADIUS.md, paddingVertical: MIUIX_SPACE.md, marginTop: MIUIX_SPACE.xs },
  } as const);
}

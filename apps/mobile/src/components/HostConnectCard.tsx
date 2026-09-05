/**
 * HostConnectCard — HyperOS 控制中心式连接卡（Miuix 设计稿 screenSessions 对齐）
 *
 * 设计语言：tertiaryContainer 大圆角(22)卡片，头部=主机图标+名称+状态 pill+chevron；
 * 点按展开控制中心面板：Host 地址 / Token 输入、保持连接 Switch、链路延迟、重连按钮。
 */
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from "react-native";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../theme";
import { useHost } from "../store";
import { LineIcon } from "./LineIcon";
import { MiuixSwitch } from "./MiuixSwitch";

export function HostConnectCard({ hostUrl, token, onHostUrlChange, onTokenChange }: {
  hostUrl: string;
  token: string;
  onHostUrlChange: (v: string) => void;
  onTokenChange: (v: string) => void;
}) {
  const { theme } = useTheme();
  const { isConnected, connectionState, connect, disconnect, lastError } = useHost();
  const [open, setOpen] = useState(false);
  // P3-5：keepAlive 接入真实语义 —— 关闭时不再自动重连（HostClient.close 后不再拉起）；
  // 开启时（默认）断线自动重连。开关变化即时生效：关闭时若在重连中则断开，重新打开时重连。
  const [keepAlive, setKeepAlive] = useState(true);
  const [latency, setLatency] = useState<number | null>(null);

  const busy = connectionState === "connecting" || connectionState === "reconnecting";
  const styles = makeStyles(theme);

  const handleKeepAliveChange = (v: boolean) => {
    setKeepAlive(v);
    if (!v) {
      // 关闭保活：断开当前连接（用户手动重连才拉起）
      if (isConnected || busy) disconnect();
    } else if (hostUrl.trim()) {
      // 重新开启：立即按当前参数重连
      connect(hostUrl.trim(), token.trim() || undefined);
    }
  };

  // P3-5：链路延迟测真实 host 端点（/api/status），而非 Metro dev server（localhost:8081 是手机自身）。
  // ws://ip:port/ws → http://ip:port/api/status?token=...；失败不显示数值。
  React.useEffect(() => {
    if (!isConnected || !hostUrl) { setLatency(null); return; }
    let alive = true;
    const httpBase = hostUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
    const statusUrl = `${httpBase}/api/status${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const tick = () => {
      const t0 = Date.now();
      void fetch(statusUrl)
        .then((res) => {
          // 仅成功响应计为有效 RTT；401/5xx 不作为延迟数值
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

  const statusColor = isConnected ? theme.success : busy ? theme.accent : theme.error;
  const statusText = isConnected ? "已连接" : busy ? (connectionState === "connecting" ? "连接中" : "重连中") : "未连接";

  return (
    <View style={[styles.card, { backgroundColor: theme.tertiaryContainer ?? theme.cardBg }]} accessibilityRole="button" accessibilityLabel={`Host 连接卡，${statusText}`}>
      <TouchableOpacity style={styles.head} onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={open ? "收起连接控制中心" : "展开连接控制中心"}>
        <View style={[styles.iconWrap, { backgroundColor: theme.surfaceVariant }]}>
          <LineIcon name="image" size={20} color={theme.onTertiaryContainer ?? theme.accent} />
        </View>
        <View style={styles.meta}>
          <Text style={[styles.name, { color: theme.text }]}>MacBook · Host</Text>
          <Text style={[styles.sub, { color: theme.onBackgroundVariant ?? theme.muted }]} numberOfLines={1}>
            {hostUrl || "ws://<PC-IP>:4739/ws"}
          </Text>
        </View>
        <View style={[styles.pill, { backgroundColor: theme.surfaceVariant }]}>
          <View style={[styles.led, { backgroundColor: statusColor }]} />
          <Text style={[styles.pillText, { color: theme.text }]}>{statusText}</Text>
        </View>
        <LineIcon name="expand" size={18} color={theme.onTertiaryContainer ?? theme.muted} />
      </TouchableOpacity>

      {open && (
        <View style={styles.panel}>
          <Text style={[styles.label, { color: theme.onBackgroundVariant ?? theme.muted }]}>Host 地址</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.surfaceVariant, color: theme.text, borderColor: theme.outline ?? theme.border }]}
            value={hostUrl}
            onChangeText={onHostUrlChange}
            placeholder="ws://<PC-IP>:4739/ws"
            placeholderTextColor={theme.onBackgroundVariant ?? theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={[styles.label, { color: theme.onBackgroundVariant ?? theme.muted }]}>Token（可选）</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.surfaceVariant, color: theme.text, borderColor: theme.outline ?? theme.border }]}
            value={token}
            onChangeText={onTokenChange}
            placeholder="mstro_····"
            placeholderTextColor={theme.onBackgroundVariant ?? theme.muted}
            autoCapitalize="none"
            secureTextEntry
          />
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
              onPress={() => { if (hostUrl.trim()) connect(hostUrl.trim(), token.trim() || undefined); }}
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
                  <Text style={styles.btnText}>  重新连接</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          {lastError ? <Text style={[styles.errorText, { color: theme.error }]}>{lastError}</Text> : null}
        </View>
      )}
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
    label: { fontSize: MIUIX_TYPE.footnote1, marginBottom: MIUIX_SPACE.xs },
    input: {
      borderRadius: MIUIX_RADIUS.md,
      borderWidth: 1,
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: MIUIX_SPACE.sm,
      fontSize: MIUIX_TYPE.body2,
      minHeight: 44,
      marginBottom: MIUIX_SPACE.md,
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
  });
}

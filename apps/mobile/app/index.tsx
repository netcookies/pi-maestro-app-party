import React, { useState, useEffect, useMemo } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";

export default function HomeScreen() {
  const router = useRouter();
  const { isConnected, connectionState, connect, disconnect, state, lastError } = useHost();
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [hostUrl, setHostUrl] = useState("ws://127.0.0.1:4739/ws");
  const [token, setToken] = useState("");

  const handleConnect = () => {
    if (!hostUrl.trim()) {
      Alert.alert("错误", "请输入 Host 地址");
      return;
    }
    connect(hostUrl.trim(), token.trim() || undefined);
  };

  const busy = connectionState === "connecting" || connectionState === "reconnecting";
  const statusColor = isConnected
    ? theme.success
    : connectionState === "reconnecting"
      ? theme.warning
      : connectionState === "connecting"
        ? theme.accent
        : theme.error;

  // 开发模式：启动时自动连接默认 Host（模拟器验证用）
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isConnected && hostUrl.trim()) {
        connect(hostUrl.trim(), token.trim() || undefined);
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Maestro Mobile</Text>
        <Text style={[styles.status, { color: statusColor }]}>
          {isConnected ? "● 已连接" : connectionState === "connecting" ? "● 连接中..." : connectionState === "reconnecting" ? "● 重连中..." : "● 未连接"}
        </Text>
      </View>

      <ScrollView style={styles.body}>
        {/* 连接配置 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Host 连接</Text>
          <TextInput
            style={styles.input}
            value={hostUrl}
            onChangeText={setHostUrl}
            placeholder="ws://<PC-IP>:4739/ws"
            placeholderTextColor="#484f58"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="Token（可选）"
            placeholderTextColor="#484f58"
            autoCapitalize="none"
            secureTextEntry
          />
          <View style={styles.buttonRow}>
            {isConnected ? (
              <TouchableOpacity style={[styles.button, styles.buttonDanger]} onPress={disconnect}>
                <Text style={styles.buttonText}>断开</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.button, styles.buttonPrimary, busy && styles.buttonDisabled]}
                onPress={handleConnect}
                disabled={busy}
              >
                <Text style={styles.buttonText}>
                  {connectionState === "connecting" ? "连接中…" : connectionState === "reconnecting" ? "重连中…" : "连接"}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
        </View>

        {/* 入口导航 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>功能</Text>

          <TouchableOpacity
            style={styles.navItem}
            onPress={() => {
              if (!isConnected) { Alert.alert("提示", "请先连接 Host"); return; }
              router.push("/host-sessions");
            }}
          >
            <Text style={styles.navTitle}>💬 Chat 会话</Text>
            <Text style={styles.navDesc}>与 Pi agent 对话（支持 ask 弹窗）</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.navItem} onPress={() => router.push("/teammate")}>
            <Text style={styles.navTitle}>🤖 Teammate 调度</Text>
            <Text style={styles.navDesc}>查看 flow-schedule 任务进度</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.navItem} onPress={() => router.push("/monitor")}>
            <Text style={styles.navTitle}>📊 Monitor 窗口</Text>
            <Text style={styles.navDesc}>窗口状态与 attention</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.navItem} onPress={() => router.push("/settings")}>
            <Text style={styles.navTitle}>⚙️ 设置</Text>
            <Text style={styles.navDesc}>关于与帮助</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    header: {
      paddingTop: 60,
      paddingHorizontal: MIUIX_SPACE.lg,
      paddingBottom: MIUIX_SPACE.lg,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    title: { fontSize: 24, fontWeight: "700", color: theme.text },
    status: { marginTop: MIUIX_SPACE.xs, fontSize: 13 },
    body: { flex: 1, padding: MIUIX_SPACE.lg },
    card: {
      backgroundColor: theme.cardBg,
      borderRadius: MIUIX_RADIUS.lg,
      padding: MIUIX_SPACE.lg,
      marginBottom: MIUIX_SPACE.lg,
      borderWidth: 1,
      borderColor: theme.border,
    },
    cardTitle: { fontSize: MIUIX_TYPE.main, fontWeight: "700", color: theme.text, marginBottom: MIUIX_SPACE.md },
    input: {
      backgroundColor: theme.inputBg,
      borderRadius: MIUIX_RADIUS.md,
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: MIUIX_SPACE.sm,
      color: theme.text,
      marginBottom: MIUIX_SPACE.sm,
      borderWidth: 1,
      borderColor: theme.border,
    },
    buttonRow: { flexDirection: "row", gap: MIUIX_SPACE.sm },
    button: { flex: 1, borderRadius: MIUIX_RADIUS.sm, paddingVertical: MIUIX_SPACE.md, alignItems: "center" },
    buttonPrimary: { backgroundColor: theme.buttonPrimary },
    buttonDanger: { backgroundColor: theme.buttonDanger },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    error: { color: theme.error, marginTop: MIUIX_SPACE.sm, fontSize: 13 },
    navItem: {
      backgroundColor: theme.inputBg,
      borderRadius: MIUIX_RADIUS.md,
      padding: MIUIX_SPACE.md,
      marginBottom: MIUIX_SPACE.sm,
      borderWidth: 1,
      borderColor: theme.border,
    },
    navTitle: { fontSize: MIUIX_TYPE.main, fontWeight: "600", color: theme.text },
    navDesc: { fontSize: MIUIX_TYPE.body2, color: theme.muted, marginTop: MIUIX_SPACE.xs, lineHeight: 20 },
  });
}
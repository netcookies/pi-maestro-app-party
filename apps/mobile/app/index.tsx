import React, { useState, useEffect, useMemo } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";

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

  const statusColor = isConnected ? theme.success : connectionState === "reconnecting" ? theme.warning : theme.error;

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
              <TouchableOpacity style={[styles.button, styles.buttonPrimary]} onPress={handleConnect}>
                <Text style={styles.buttonText}>连接</Text>
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
      paddingHorizontal: 20,
      paddingBottom: 16,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    title: { fontSize: 24, fontWeight: "700", color: theme.text },
    status: { marginTop: 4, fontSize: 13 },
    body: { flex: 1, padding: 16 },
    card: {
      backgroundColor: theme.cardBg,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: theme.border,
    },
    cardTitle: { fontSize: 16, fontWeight: "600", color: theme.text, marginBottom: 12 },
    input: {
      backgroundColor: theme.inputBg,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: theme.border,
    },
    buttonRow: { flexDirection: "row", gap: 10 },
    button: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
    buttonPrimary: { backgroundColor: theme.buttonPrimary },
    buttonDanger: { backgroundColor: theme.buttonDanger },
    buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    error: { color: theme.error, marginTop: 8, fontSize: 13 },
    navItem: {
      backgroundColor: theme.inputBg,
      borderRadius: 8,
      padding: 14,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: theme.border,
    },
    navTitle: { fontSize: 15, fontWeight: "600", color: theme.text },
    navDesc: { fontSize: 12, color: theme.muted, marginTop: 4 },
  });
}
import React from "react";
import { View, Text, StyleSheet, ScrollView, Linking } from "react-native";
import { useHost } from "../src/store";

export default function SettingsScreen() {
  const { connectionState, isConnected, state } = useHost();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Maestro Mobile</Text>
        <Text style={styles.version}>版本 0.1.0</Text>
        <Text style={styles.desc}>
          在移动端使用 Pi Agent + pi-maestro-flow 的 Bridge 方案。
          基于 pi-mobile 的 SDK Host 架构，复用 pi-maestro-flow 的 teammate/monitor 能力。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>连接状态</Text>
        <View style={styles.row}>
          <Text style={styles.label}>状态</Text>
          <Text style={[styles.value, { color: isConnected ? "#3fb950" : "#f85149" }]}>
            {connectionState}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>活跃会话</Text>
          <Text style={styles.value}>{state.sessions.size}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Maestro 调度</Text>
          <Text style={styles.value}>{state.maestro?.schedules.length ?? 0}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Monitor 窗口</Text>
          <Text style={styles.value}>{state.monitor?.windows.length ?? 0}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>架构说明</Text>
        <Text style={styles.desc}>
          Bridge 模式：独立 SDK Host 进程（createAgentSession + bindExtensions），
          MobileExtensionUiBridge 将 maestro ask 的 ctx.ui.select/input/confirm 映射为 extension_ui_request 事件流，
          移动端 ExtensionUiDialog 弹窗渲染，用户作答后返回。ask-question 在移动端完整可用。
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>安全</Text>
        <Text style={styles.desc}>
          移动端是 Pi 的远程入口。建议设置 MAESTRO_MOBILE_TOKEN 鉴权，
          或通过 Tailscale / SSH 隧道访问。不要无鉴权暴露在公网。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117" },
  content: { padding: 16 },
  card: {
    backgroundColor: "#161b22",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#21262d",
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: "#e6edf3", marginBottom: 8 },
  version: { fontSize: 13, color: "#8b949e", marginBottom: 12 },
  desc: { fontSize: 13, color: "#8b949e", lineHeight: 20 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  label: { fontSize: 14, color: "#8b949e" },
  value: { fontSize: 14, fontWeight: "600", color: "#e6edf3" },
});
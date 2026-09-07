/**
 * pair — 深链配对路由（maestro-mobile://pair?ws=...&token=...）
 *
 * 三个入口都汇到这里：
 * 1. PC 终端 QR（相机扫码 → QRPairScanner 直接解析，不经此页）
 * 2. 手机相册识别 QR 后打开链接（微信/系统相册扫码 → 浏览器 → 本页）
 * 3. iOS 模拟器等无相机环境（xcrun simctl openurl 直接注入）
 *
 * 语义：解析成功 → 存入配对列表 → 回会话页自动连接；解析失败 → 显示错误。
 */
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import { useHost } from "../src/store";
import { extractPairing } from "../src/pairing";
import { loadPairedHosts, savePairedHosts } from "../src/paired-hosts";

export default function PairScreen() {
  const { theme } = useTheme();
  const styles = useMemoStyles(theme);
  const params = useLocalSearchParams<{ ws?: string; token?: string }>();
  const { connect } = useHost();
  const [status, setStatus] = useState<"parsing" | "ok" | "error">("parsing");
  const [message, setMessage] = useState("");

  useEffect(() => {
    // expo-router 对 query 里的编码值自动解码；先拼回原始串再解析
    const raw = `maestro-mobile://pair?ws=${params.ws ?? ""}&token=${params.token ?? ""}`;
    const info = extractPairing(raw);
    if (!info) {
      setStatus("error");
      setMessage("配对链接无效：缺少 ws 地址或格式不正确。\n请在 PC 终端重新执行 /maestro-mobile qr 获取新二维码。");
      return;
    }
    void (async () => {
      const paired = await loadPairedHosts();
      await savePairedHosts([
        { name: info.displayHost, hostUrl: info.hostUrl, token: info.token ?? "", pairedAt: new Date().toISOString() },
        ...paired.filter((p) => p.hostUrl !== info.hostUrl),
      ].slice(0, 8));
      // 同步单连接参数键：host-sessions remount（router.replace 触发）后 autoReconnect 读这里，
      // 否则旧持久化参数（无 token）会在 600ms 后顶掉本次配对连接
      const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
      await AsyncStorage.setItem("maestro-mobile.host-connection", JSON.stringify({ hostUrl: info.hostUrl, token: info.token ?? "" }));
      connect(info.hostUrl, info.token);
      setStatus("ok");
      setMessage(`已配对 ${info.displayHost}，正在连接…`);
      setTimeout(() => router.replace("/host-sessions"), 1200);
    })();
  }, [params.ws, params.token, connect]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <Text style={[styles.title, { color: theme.text }]}>扫码配对</Text>
      {status === "parsing" && <ActivityIndicator size="large" color={theme.accent} />}
      {status === "ok" && <Text style={[styles.icon, { color: theme.success }]}>✓</Text>}
      {status === "error" && <Text style={[styles.icon, { color: theme.error }]}>✗</Text>}
      <Text style={[styles.message, { color: status === "error" ? theme.error : theme.onBackgroundVariant ?? theme.muted }]}>
        {message}
      </Text>
      {status === "error" && (
        <TouchableOpacity
          style={[styles.backBtn, { backgroundColor: theme.buttonPrimary }]}
          onPress={() => router.replace("/host-sessions")}
          accessibilityRole="button"
          accessibilityLabel="返回会话页"
        >
          <Text style={styles.backText}>返回手动连接</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function useMemoStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, alignItems: "center", justifyContent: "center", padding: MIUIX_SPACE.xl, gap: MIUIX_SPACE.lg },
    title: { fontSize: MIUIX_TYPE.title1, fontWeight: "700" },
    icon: { fontSize: 56, fontWeight: "700" },
    message: { fontSize: MIUIX_TYPE.body2, textAlign: "center", lineHeight: 20 },
    backBtn: { borderRadius: MIUIX_RADIUS.md, paddingHorizontal: MIUIX_SPACE.xl, paddingVertical: MIUIX_SPACE.md, marginTop: MIUIX_SPACE.md },
    backText: { color: "#fff", fontWeight: "600" },
  });
}

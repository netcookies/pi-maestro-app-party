import { Tabs, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native";
import { HostStoreProvider } from "../src/store";
import { ThemeProvider, useTheme } from "../src/theme";
import { LineIcon, type LineIconName } from "../src/components/LineIcon";
import { loadConfig } from "../src/config";
import { useEffect } from "react";

/**
 * 导航架构（对齐 Miuix 设计稿 NavigationBar）：
 * 主壳 = 底部 Tabs 4 个（会话 host-sessions / Teammate / Monitor / 设置），
 * 会话聊天 session 为 stack 内二级页（无 tab）。
 * index 入口页重定向到 /host-sessions（原连接功能已迁移到会话页 HostConnectCard）。
 */
const TAB_ICONS: Record<string, LineIconName> = {
  "host-sessions": "image",
  teammate: "plan",
  monitor: "bolt",
  settings: "compress",
};

const TAB_LABELS: Record<string, string> = {
  sessions: "会话",
  teammate: "Teammate",
  monitor: "Monitor",
  settings: "设置",
};

function RootNavigator() {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar style={theme.bg === "#f7f7f5" || theme.name === "notion" ? "dark" : "light"} />
      <Tabs
        screenOptions={{
          initialRouteName: "host-sessions",
          headerStyle: { backgroundColor: theme.headerBg },
          headerTintColor: theme.headerText,
          headerTitleStyle: { fontSize: 24, fontWeight: "700" },
          contentStyle: { backgroundColor: theme.bg },
          tabBarActiveTintColor: theme.accent,
          tabBarInactiveTintColor: theme.muted,
          tabBarStyle: {
            backgroundColor: theme.headerBg,
            borderTopColor: theme.border,
          },
          tabBarIcon: ({ route, color }) => {
            // P3-6：按 route name 取真实图标（此前写死 sessions 图标）；
            // 各 Screen 已自行覆盖时此处不会触发，仅作为兜底。
            const name = TAB_ICONS[route.name] ?? "plan";
            return <LineIcon name={name} size={22} color={color} />;
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="host-sessions"
          options={{
            title: "会话",
            tabBarIcon: ({ color }) => <LineIcon name="image" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="teammate"
          options={{
            title: "Teammate",
            tabBarIcon: ({ color }) => <LineIcon name="plan" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="monitor"
          options={{
            title: "Monitor",
            tabBarIcon: ({ color }) => <LineIcon name="bolt" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "设置",
            tabBarIcon: ({ color }) => <LineIcon name="compress" size={22} color={color} />,
          }}
        />
        <Tabs.Screen
          name="session"
          options={{ href: null, headerShown: false }}
        />
      </Tabs>
    </>
  );
}

export default function RootLayout() {
  // 启动即加载持久化配置（设置页参数 / 主题共享加载时机）
  useEffect(() => {
    void loadConfig();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <HostStoreProvider>
            <RootNavigator />
          </HostStoreProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

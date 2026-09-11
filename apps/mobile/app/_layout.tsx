import { Tabs, Stack, useRouter, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native";
import { HostStoreProvider } from "../src/store";
import { ThemeProvider, useTheme } from "../src/theme";
import { I18nProvider, useI18n } from "../src/i18n";
import { LineIcon, type LineIconName } from "../src/components/LineIcon";
import { loadConfig } from "../src/config";
import { useEffect, useRef } from "react";
import * as Camera from "expo-camera";
import * as ImagePicker from "expo-image-picker";

/**
 * 导航架构（方向 A：Dashboard 工作台为首页）：
 * 主壳 = 底部 Tabs 4 个（工作台 dashboard / 会话 host-sessions / Monitor / 设置），
 * 会话聊天 session 为 stack 内二级页（无 tab）。
 * index 不再 Redirect，直接作为工作台态势总览页；Teammate 页保留为会话页二级入口（待后续接入）。
 */
const TAB_ICONS: Record<string, LineIconName> = {
  dashboard: "workbench",
  "host-sessions": "chat",
  teammate: "plan",
  monitor: "monitor",
  settings: "settings",
};

const TAB_LABELS: Record<string, string> = {
  dashboard: "工作台",
  sessions: "会话",
  monitor: "Monitor",
  settings: "设置",
};

function RootNavigator() {
  const { theme } = useTheme();
  const { t } = useI18n();

  return (
    <SafeAreaProvider>
      <StatusBar style={theme.bg === "#f7f7f5" || theme.name === "notion" ? "dark" : "light"} />
      <Tabs
        screenOptions={{
          initialRouteName: "index",
          headerShown: false,
          contentStyle: { backgroundColor: theme.bg },
          tabBarActiveTintColor: theme.accent,
          tabBarInactiveTintColor: theme.muted,
          tabBarStyle: {
            backgroundColor: theme.headerBg,
            borderTopColor: theme.border,
            borderTopWidth: 1,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: -3 },
            shadowOpacity: 0.12,
            shadowRadius: 6,
            elevation: 8,
          },
          tabBarIcon: (opts) => {
            const name = TAB_ICONS[opts?.route?.name ?? ""] ?? "plan";
            return <LineIcon name={name} size={22} color={opts?.color ?? "#888"} />;
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t.tabWorkbench,
            tabBarIcon: ({ color }) => <LineIcon name="workbench" size={20} color={color} />,
          }}
        />
        <Tabs.Screen
          name="host-sessions"
          options={{
            title: t.tabSessions,
            tabBarIcon: ({ color }) => <LineIcon name="chat" size={20} color={color} />,
          }}
        />
        <Tabs.Screen
          name="teammate"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="pair"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="pair-scan"
          options={{ href: null, headerShown: false }}
        />
        <Tabs.Screen
          name="monitor"
          options={{
            title: t.tabMonitor,
            tabBarIcon: ({ color }) => <LineIcon name="monitor" size={20} color={color} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: t.tabSettings,
            tabBarIcon: ({ color }) => <LineIcon name="settings" size={20} color={color} />,
          }}
        />
        <Tabs.Screen
          name="session"
          options={{
            href: null,
            headerShown: false,
            tabBarStyle: { display: "none" },
          }}
        />
      </Tabs>
    </SafeAreaProvider>
  );
}

export default function RootLayout() {
  const permissionsRequested = useRef(false);

  // Ask once at app entry. Camera and library are independent; neither implies microphone access.
  useEffect(() => {
    if (permissionsRequested.current) return;
    permissionsRequested.current = true;
    void (async () => {
      try { await Camera.requestCameraPermissionsAsync(); } catch { /* permission prompt unavailable */ }
      try { await ImagePicker.requestMediaLibraryPermissionsAsync(); } catch { /* permission prompt unavailable */ }
    })();
  }, []);

  // 启动即加载持久化配置（设置页参数 / 主题共享加载时机）
  useEffect(() => {
    void loadConfig();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <I18nProvider>
            <HostStoreProvider>
              <RootNavigator />
            </HostStoreProvider>
          </I18nProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

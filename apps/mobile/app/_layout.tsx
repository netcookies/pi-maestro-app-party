import "react-native-gesture-handler";
import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationEventMap,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { withLayoutContext } from "expo-router";
import screenTransitions, {
  type NativeStackAdapterOptions,
  withScreenTransitions,
} from "react-native-screen-transitions";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet, View } from "react-native";
import { HostStoreProvider } from "../src/store";
import { ThemeProvider, useTheme } from "../src/theme";
import { I18nProvider } from "../src/i18n";
import { loadConfig } from "../src/config";
import { useEffect, useRef } from "react";
import * as Camera from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useHost } from "../src/store";
import { initNotificationService, notifyPendingAsk, notifyAgentSettled } from "../src/notifications";
import * as Notifications from "expo-notifications";
import { InAppNotificationBanner } from "../src/components/InAppNotificationBanner";

const NativeStack = createNativeStackNavigator();
const TransitionStack = withScreenTransitions(NativeStack);
type RootStackOptions = NativeStackAdapterOptions<NativeStackNavigationOptions>;
const Stack = withLayoutContext<
  RootStackOptions,
  typeof TransitionStack.Navigator,
  StackNavigationState<ParamListBase>,
  NativeStackNavigationEventMap
>(TransitionStack.Navigator);

function RootNavigator() {
  const { theme } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar style={theme.bg === "#f7f7f5" || theme.name === "notion" ? "dark" : "light"} />
      <Stack
        id="root"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.bg },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="session"
          options={{
            ...screenTransitions.Presets.DraggableCard({
              gestureDirection: "horizontal",
            }),
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="model-select"
          options={{
            ...screenTransitions.Presets.DraggableCard({
              gestureDirection: "horizontal",
            }),
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="pair-scan"
          options={{
            ...screenTransitions.Presets.SlideFromBottom({
              gestureDirection: "vertical",
            }),
            headerShown: false,
          }}
        />
      </Stack>
    </View>
  );
}

function NotificationWatcher() {
  const { state, fetchMonitorState, isConnected } = useHost();

  // 全局定时同步 monitor 状态，确保在任何页面都能及时捕获未决 ask 与完成事件
  useEffect(() => {
    if (!isConnected) return;
    void fetchMonitorState();
    const timer = setInterval(() => {
      void fetchMonitorState();
    }, 2500);
    return () => clearInterval(timer);
  }, [isConnected, fetchMonitorState]);

  // 监听 Ask 待办状态并触发系统通知
  useEffect(() => {
    const windows = state.monitor?.windows ?? [];
    for (const w of windows) {
      if (w.pendingAsk && w.pendingAsk.toolCallId) {
        void notifyPendingAsk(
          w.identity.endpointId,
          w.pendingAsk.toolCallId,
          w.name ?? "桌面会话",
          w.pendingAsk.question ?? "需要您的操作确认",
          w.name,
        );
      }
    }
  }, [state.monitor?.windows]);

  // 监听 Agent 完成结算状态并触发完成通知
  const prevSettledTimes = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const windows = state.monitor?.windows ?? [];
    for (const w of windows) {
      if (w.lastSettle && typeof w.lastSettle.at === "number") {
        const prev = prevSettledTimes.current.get(w.identity.endpointId);
        if (prev === undefined) {
          // 首次加载初始化记录，不补弹历史完成通知
          prevSettledTimes.current.set(w.identity.endpointId, w.lastSettle.at);
        } else if (w.lastSettle.at > prev) {
          prevSettledTimes.current.set(w.identity.endpointId, w.lastSettle.at);
          void notifyAgentSettled(
            w.identity.endpointId,
            w.name ?? "桌面会话",
            w.lastSettle.lastResult,
          );
        }
      }
    }
  }, [state.monitor?.windows]);

  return null;
}

export default function RootLayout() {
  const permissionsRequested = useRef(false);
  const router = useRouter();

  // 监听系统通知点击跳转
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      try {
        const data = response.notification.request.content.data;
        const sessionId = typeof data?.sessionId === "string" ? data.sessionId : null;
        if (sessionId) {
          router.push({
            pathname: "/session",
            params: { id: sessionId },
          });
        }
      } catch {}
    });
    return () => subscription.remove();
  }, [router]);

  // Ask once at app entry. Camera and library are independent; neither implies microphone access.
  useEffect(() => {
    if (permissionsRequested.current) return;
    permissionsRequested.current = true;
    void (async () => {
      try { await Camera.requestCameraPermissionsAsync(); } catch { /* permission prompt unavailable */ }
      try { await ImagePicker.requestMediaLibraryPermissionsAsync(); } catch { /* permission prompt unavailable */ }
      try { await initNotificationService(); } catch { /* notification unavailable */ }
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
              <NotificationWatcher />
              <InAppNotificationBanner />
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

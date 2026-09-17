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
  const { state, isConnected } = useHost();

  // Ask 待办通知与完成通知均由 Host 事件流投影 state 驱动。

  // 监听 Ask 待办状态并触发系统通知（extension-ui 队列 pending 弹窗）
  useEffect(() => {
    for (const dialog of state.dialogs) {
      if (dialog.status !== "pending") continue;
      void notifyPendingAsk(
        dialog.request.sessionId,
        dialog.request.id,
        dialog.request.title ?? "桌面会话",
        dialog.request.message ?? "需要您的操作确认",
      );
    }
  }, [state.dialogs]);

  // 监听 Agent 完成结算状态并触发完成通知（streaming → idle 收敛即一轮完成）
  const prevStreaming = useRef<Set<string>>(new Set());
  useEffect(() => {
    const nowStreaming = new Set<string>();
    for (const session of state.sessions.values()) {
      if (session.runState === "streaming") nowStreaming.add(session.id);
    }
    for (const id of prevStreaming.current) {
      if (nowStreaming.has(id)) continue;
      const session = state.sessions.get(id);
      if (!session || session.runState === "error" || session.runState === "aborting") continue;
      void notifyAgentSettled(id, session.title || "桌面会话");
    }
    prevStreaming.current = nowStreaming;
  }, [state.sessions]);

  // 断线时清空记录（防重连后误判「刚完成」重复弹通知）
  useEffect(() => {
    if (!isConnected) prevStreaming.current = new Set();
  }, [isConnected]);

  return null;
}

export default function RootLayout() {
  const permissionsRequested = useRef(false);
  const [, requestCameraPermission] = Camera.useCameraPermissions();
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
      try { await requestCameraPermission(); } catch { /* permission prompt unavailable */ }
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

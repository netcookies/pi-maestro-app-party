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

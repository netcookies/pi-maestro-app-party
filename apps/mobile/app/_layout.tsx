import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native";
import { HostStoreProvider } from "../src/store";
import { ThemeProvider, useTheme } from "../src/theme";

function RootNavigator() {
  const { theme } = useTheme();
  return (
    <>
      <StatusBar style={theme.bg === "#f7f7f5" || theme.name === "notion" ? "dark" : "light"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.headerBg },
          headerTintColor: theme.headerText,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ title: "连接 Host" }} />
        <Stack.Screen name="host-sessions" options={{ title: "Host 会话列表" }} />
        <Stack.Screen name="session" options={{ headerShown: false }} />
        <Stack.Screen name="teammate" options={{ title: "Teammate 调度" }} />
        <Stack.Screen name="monitor" options={{ title: "Monitor 窗口" }} />
        <Stack.Screen name="settings" options={{ title: "设置" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
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
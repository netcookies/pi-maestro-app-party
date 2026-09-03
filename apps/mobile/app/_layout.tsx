import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: "#0d1117" },
            headerTintColor: "#e6edf3",
            contentStyle: { backgroundColor: "#0d1117" },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="connect" options={{ title: "连接 Host" }} />
          <Stack.Screen name="session" options={{ title: "会话" }} />
          <Stack.Screen name="teammate" options={{ title: "Teammate 调度" }} />
          <Stack.Screen name="monitor" options={{ title: "Monitor 窗口" }} />
          <Stack.Screen name="settings" options={{ title: "设置" }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

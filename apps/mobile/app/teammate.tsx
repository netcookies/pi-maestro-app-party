import React from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from "react-native";
import { useHost } from "../src/store";
import type { MaestroScheduleSummary, MaestroStepSummary, MaestroDispatchSummary } from "@maestro-mobile/shared";

export default function TeammateScreen() {
  const { state } = useHost();
  const schedules = state.maestro?.schedules ?? [];

  const renderDispatch = ({ item }: { item: MaestroDispatchSummary }) => (
    <View style={styles.dispatch}>
      <Text style={styles.dispatchId}>{item.dispatchId.slice(0, 16)}...</Text>
      <Text style={[styles.dispatchState, statusColor(item.state)]}>{item.state}</Text>
      {item.task ? <Text style={styles.dispatchTask}>{item.task}</Text> : null}
      {item.error ? <Text style={styles.errorText}>{item.error}</Text> : null}
    </View>
  );

  const renderStep = ({ item }: { item: MaestroStepSummary }) => (
    <View style={styles.step}>
      <View style={styles.stepHeader}>
        <Text style={styles.stepId}>{item.stepId}</Text>
        <Text style={[styles.stepState, statusColor(item.state)]}>{item.state}</Text>
      </View>
      {item.title ? <Text style={styles.stepTitle}>{item.title}</Text> : null}
      {item.dispatches.length > 0 && (
        <FlatList
          data={item.dispatches}
          keyExtractor={(d) => d.dispatchId}
          renderItem={renderDispatch}
          scrollEnabled={false}
        />
      )}
    </View>
  );

  const renderSchedule = ({ item }: { item: MaestroScheduleSummary }) => (
    <View style={styles.schedule}>
      <View style={styles.scheduleHeader}>
        <Text style={styles.scheduleTitle}>{item.title || item.scheduleId}</Text>
        <Text style={[styles.scheduleState, statusColor(item.state)]}>{item.state}</Text>
      </View>
      <Text style={styles.progress}>
        进度: {item.progress.completed}/{item.progress.total}
      </Text>
      {item.steps.length > 0 && (
        <FlatList
          data={item.steps}
          keyExtractor={(s) => s.stepId}
          renderItem={renderStep}
          scrollEnabled={false}
        />
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      {schedules.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>暂无调度任务</Text>
          <Text style={styles.emptyDesc}>请确保 Host 端有正在运行的 flow-schedule</Text>
        </View>
      ) : (
        <FlatList
          data={schedules}
          keyExtractor={(s) => s.scheduleId}
          renderItem={renderSchedule}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function statusColor(state: string) {
  switch (state) {
    case "completed": return { color: "#3fb950" };
    case "failed": case "timeout": return { color: "#f85149" };
    case "active": case "published": case "accepted": return { color: "#58a6ff" };
    case "pending": case "prepared": return { color: "#8b949e" };
    default: return { color: "#d29922" };
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117" },
  list: { padding: 16 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  emptyText: { fontSize: 16, color: "#8b949e", fontWeight: "600" },
  emptyDesc: { fontSize: 13, color: "#484f58", marginTop: 8, textAlign: "center" },
  schedule: {
    backgroundColor: "#161b22",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#21262d",
  },
  scheduleHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  scheduleTitle: { fontSize: 16, fontWeight: "600", color: "#e6edf3", flex: 1 },
  scheduleState: { fontSize: 12, fontWeight: "600" },
  progress: { fontSize: 12, color: "#8b949e", marginBottom: 10 },
  step: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#21262d",
  },
  stepHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  stepId: { fontSize: 12, fontWeight: "600", color: "#e6edf3" },
  stepState: { fontSize: 11, fontWeight: "600" },
  stepTitle: { fontSize: 12, color: "#8b949e", marginBottom: 6 },
  dispatch: { backgroundColor: "#0d1117", borderRadius: 6, padding: 8, marginBottom: 4 },
  dispatchId: { fontSize: 11, color: "#484f58" },
  dispatchState: { fontSize: 11, fontWeight: "600" },
  dispatchTask: { fontSize: 12, color: "#8b949e", marginTop: 2 },
  errorText: { fontSize: 11, color: "#f85149", marginTop: 2 },
});
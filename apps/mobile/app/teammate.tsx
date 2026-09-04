import React from "react";
import { View, Text, StyleSheet, FlatList } from "react-native";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import type { MaestroScheduleSummary, MaestroStepSummary, MaestroDispatchSummary } from "@maestro-mobile/shared";

type Row =
  | { type: "schedule"; schedule: MaestroScheduleSummary }
  | { type: "step"; step: MaestroStepSummary; scheduleId: string }
  | { type: "dispatch"; dispatch: MaestroDispatchSummary };

export default function TeammateScreen() {
  const { state } = useHost();
  const { theme } = useTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const schedules = state.maestro?.schedules ?? [];

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const schedule of schedules) {
      out.push({ type: "schedule", schedule });
      for (const step of schedule.steps) {
        out.push({ type: "step", step, scheduleId: schedule.scheduleId });
        for (const dispatch of step.dispatches) {
          out.push({ type: "dispatch", dispatch });
        }
      }
    }
    return out;
  }, [schedules]);

  const keyExtractor = (item: Row) => {
    switch (item.type) {
      case "schedule": return `schedule:${item.schedule.scheduleId}`;
      case "step": return `step:${item.scheduleId}:${item.step.stepId}`;
      case "dispatch": return `dispatch:${item.dispatch.dispatchId}`;
    }
  };

  const renderItem = ({ item }: { item: Row }) => {
    if (item.type === "schedule") {
      const s = item.schedule;
      return (
        <View style={styles.schedule}>
          <View style={styles.scheduleHeader}>
            <Text style={styles.scheduleTitle}>{s.title || s.scheduleId}</Text>
            <Text style={[styles.scheduleState, statusColor(s.state, theme)]}>{s.state}</Text>
          </View>
          <Text style={styles.progress}>
            进度: {s.progress.completed}/{s.progress.total}
          </Text>
        </View>
      );
    }
    if (item.type === "step") {
      const st = item.step;
      return (
        <View style={styles.step}>
          <View style={styles.stepHeader}>
            <Text style={styles.stepId}>{st.stepId}</Text>
            <Text style={[styles.stepState, statusColor(st.state, theme)]}>{st.state}</Text>
          </View>
          {st.title ? <Text style={styles.stepTitle}>{st.title}</Text> : null}
        </View>
      );
    }
    const d = item.dispatch;
    return (
      <View style={styles.dispatch}>
        <Text style={styles.dispatchId} numberOfLines={1} ellipsizeMode="middle">
          {d.dispatchId.length > 16 ? d.dispatchId.slice(0, 16) + "…" : d.dispatchId}
        </Text>
        <Text style={[styles.dispatchState, statusColor(d.state, theme)]}>{d.state}</Text>
        {d.task ? <Text style={styles.dispatchTask} numberOfLines={2}>{d.task}</Text> : null}
        {d.error ? <Text style={styles.errorText} numberOfLines={2}>{d.error}</Text> : null}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {schedules.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>暂无调度任务</Text>
          <Text style={styles.emptyDesc}>请确保 Host 端有正在运行的 flow-schedule</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function statusColor(state: string, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (state) {
    case "completed": return { color: theme.success };
    case "failed": case "timeout": return { color: theme.error };
    case "active": case "published": case "accepted": return { color: theme.accent };
    case "pending": case "prepared": return { color: theme.muted };
    default: return { color: theme.warning };
  }
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    list: { padding: MIUIX_SPACE.lg },
    empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
    emptyText: { fontSize: MIUIX_TYPE.body1, color: theme.muted, fontWeight: "600" },
    emptyDesc: { fontSize: MIUIX_TYPE.footnote1, color: theme.dim, marginTop: MIUIX_SPACE.sm, textAlign: "center" },
    schedule: {
      backgroundColor: theme.cardBg,
      borderRadius: MIUIX_RADIUS.lg,
      padding: MIUIX_SPACE.lg,
      marginBottom: MIUIX_SPACE.md,
      borderWidth: 1,
      borderColor: theme.border,
    },
    scheduleHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: MIUIX_SPACE.xs },
    scheduleTitle: { fontSize: MIUIX_TYPE.main, fontWeight: "600", color: theme.text, flex: 1 },
    scheduleState: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
    progress: { fontSize: MIUIX_TYPE.footnote1, color: theme.muted },
    step: {
      backgroundColor: theme.bg,
      borderRadius: MIUIX_RADIUS.md,
      padding: MIUIX_SPACE.md,
      marginBottom: MIUIX_SPACE.sm,
      marginLeft: MIUIX_SPACE.md,
      borderWidth: 1,
      borderColor: theme.border,
    },
    stepHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: MIUIX_SPACE.xs },
    stepId: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.text },
    stepState: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600" },
    stepTitle: { fontSize: MIUIX_TYPE.body2, color: theme.muted },
    dispatch: {
      backgroundColor: theme.bg,
      borderRadius: MIUIX_RADIUS.sm,
      padding: MIUIX_SPACE.sm,
      marginBottom: MIUIX_SPACE.xs,
      marginLeft: MIUIX_SPACE.lg,
      borderWidth: 1,
      borderColor: theme.border,
    },
    dispatchId: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600", color: theme.dim },
    dispatchState: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600", marginTop: MIUIX_SPACE.xs },
    dispatchTask: { fontSize: MIUIX_TYPE.footnote1, color: theme.muted, marginTop: MIUIX_SPACE.xs },
    errorText: { fontSize: MIUIX_TYPE.footnote2, color: theme.error, marginTop: MIUIX_SPACE.xs },
  });
}

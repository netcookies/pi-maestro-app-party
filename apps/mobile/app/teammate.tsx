import React from "react";
import { View, Text, StyleSheet, FlatList } from "react-native";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import type { MaestroScheduleSummary, MaestroStepSummary, MaestroDispatchSummary, MonitorWindowSummary } from "@maestro-mobile/shared";

type Row =
  | { type: "owner"; owner: MonitorWindowSummary }
  | { type: "schedule"; schedule: MaestroScheduleSummary }
  | { type: "step"; step: MaestroStepSummary; scheduleId: string }
  | { type: "dispatch"; dispatch: MaestroDispatchSummary };

export default function TeammateScreen() {
  const { state, fetchMonitorState } = useHost();
  const { theme } = useTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const schedules = state.maestro?.schedules ?? [];
  const ownerWindows = state.monitor?.windows ?? [];

  // 进入页面主动拉取（host 只在变化时推送，后连接会错过）
  React.useEffect(() => {
    void fetchMonitorState();
  }, [fetchMonitorState]);

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = [];
    // workspace owners（活的 Pi 会话 + 运行中 agents）
    for (const w of ownerWindows) {
      out.push({ type: "owner", owner: w });
    }
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
      case "owner": return `owner:${item.owner.identity.ownerId}`;
      case "schedule": return `schedule:${item.schedule.scheduleId}`;
      case "step": return `step:${item.scheduleId}:${item.step.stepId}`;
      case "dispatch": return `dispatch:${item.dispatch.dispatchId}`;
    }
  };

  const renderItem = ({ item }: { item: Row }) => {
    if (item.type === "owner") {
      const w = item.owner;
      // 从 facets 取 agents 详情（host 投影 teammate-agents facet）
      const facet = w.facets?.find((f) => f.kind === "teammate-agents");
      const agents = (facet?.data as { agents?: { name?: string; agent?: string; status?: string; phase?: string }[] } | undefined)?.agents ?? [];
      return (
        <View style={styles.schedule}>
          <View style={styles.scheduleHeader}>
            <Text style={styles.scheduleTitle}>{w.name ?? "Pi 会话"}</Text>
            <Text style={[styles.scheduleState, statusColor(w.status)]}>
              {w.status === "running" ? "运行中" : w.status === "sleeping" ? "睡眠" : w.status}
            </Text>
          </View>
          <Text style={styles.progress}>
            {w.identity.endpointId.slice(0, 8)} · {agents.length} 个 teammate
          </Text>
          {agents.map((a, i) => (
            <View key={i} style={[styles.dispatch, { borderLeftWidth: 3, borderLeftColor: a.status === "running" ? theme.success : theme.border, paddingLeft: 8, marginBottom: 4 }]}>
              <View style={styles.scheduleHeader}>
                <Text style={[styles.sessionTitle, { color: theme.text, fontSize: 13 }]} numberOfLines={1}>
                  {a.name ?? a.agent ?? "teammate"}
                </Text>
                <Text style={[styles.scheduleState, statusColor(a.status ?? "")]}>{a.status ?? "?"}</Text>
              </View>
              {a.phase ? <Text style={[styles.progress, { marginTop: 2 }]}>phase: {a.phase}</Text> : null}
              {a.outputTail && Array.isArray(a.outputTail) && a.outputTail.length > 0 ? (
                <Text numberOfLines={2} style={[styles.dispatchId, { marginTop: 2 }]}>
                  {String(a.outputTail[a.outputTail.length - 1]).slice(0, 100)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      );
    }
    if (item.type === "schedule") {
      const s = item.schedule;
      return (
        <View style={styles.schedule}>
          <View style={styles.scheduleHeader}>
            <Text style={styles.scheduleId} numberOfLines={1} ellipsizeMode="middle">
              {s.scheduleId.length > 14 ? s.scheduleId.slice(0, 8) + "…" + s.scheduleId.slice(-4) : s.scheduleId}
            </Text>
            <StateBadge state={s.state} theme={theme} />
          </View>
          <Text style={styles.scheduleTitle} numberOfLines={2}>{s.title || "未命名调度"}</Text>
          <Text style={styles.progress}>进度: {s.progress.completed}/{s.progress.total}</Text>
        </View>
      );
    }
    if (item.type === "step") {
      const st = item.step;
      const rail = st.state === "completed" ? theme.success : st.state === "active" ? theme.accent : theme.muted;
      return (
        <View style={styles.stepRowWrap}>
          <View style={styles.railWrap}>
            <View style={[styles.railDot, { backgroundColor: rail, shadowColor: rail }]} />
            <View style={[styles.railLine, { backgroundColor: theme.dividerLine ?? theme.border }]} />
          </View>
          <View style={styles.stepBody}>
            <View style={styles.stepHeader}>
              <Text style={styles.stepId}>{st.stepId}</Text>
              <Text style={[styles.stepState, statusColor(st.state, theme)]}>{st.state}</Text>
            </View>
            {st.title ? <Text style={styles.stepTitle} numberOfLines={1}>{st.title}</Text> : null}
          </View>
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

/** 彩底状态徽标（设计稿 state-badge：running tertiaryContainer / done 绿底 / failed errorContainer） */
function StateBadge({ state, theme }: { state: string; theme: ReturnType<typeof useTheme>["theme"] }) {
  const cfg: Record<string, { bg: string; fg: string; label: string }> = {
    active: { bg: theme.tertiaryContainer ?? theme.accent, fg: theme.onTertiaryContainer ?? theme.accent, label: "RUNNING" },
    completed: { bg: theme.success, fg: "#fff", label: "DONE" },
    failed: { bg: theme.errorContainer ?? theme.error, fg: theme.error, label: "FAILED" },
  };
  const c = cfg[state] ?? { bg: theme.secondaryContainer ?? theme.border, fg: theme.muted, label: state.toUpperCase() };
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
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
    scheduleId: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600", color: theme.dim, flex: 1, fontFamily: "Menlo", marginRight: MIUIX_SPACE.sm },
    scheduleTitle: { fontSize: MIUIX_TYPE.main, fontWeight: "600", color: theme.text, marginBottom: MIUIX_SPACE.xs },
    scheduleState: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
    badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 9 },
    badgeText: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "700", letterSpacing: 0.4 },
    progress: { fontSize: MIUIX_TYPE.footnote1, color: theme.muted, fontVariant: ["tabular-nums"] },
    // 竖轨 rail（设计稿 step：细轨 + 色点）
    stepRowWrap: { flexDirection: "row", marginLeft: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    railWrap: { alignItems: "center", marginRight: MIUIX_SPACE.md, width: 12 },
    railDot: { width: 9, height: 9, borderRadius: 4.5, marginTop: 4, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 2 },
    railLine: { width: 1.5, flex: 1, marginTop: 4, opacity: 0.6 },
    stepBody: { flex: 1, minWidth: 0, paddingBottom: MIUIX_SPACE.xs },
    stepHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
    stepId: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.text, fontFamily: "Menlo" },
    stepState: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "700", letterSpacing: 0.4 },
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

/**
 * Monitor 监督会话（方向 A）
 *
 * 语义升级：不再是纯只读窗口卡片列表 —— 窗口列表同时是消息目标选择器。
 * 点击窗口即选中为 steer 消息目标（选中态高亮）；
 * 底部固定 steer 输入框，目标窗口不可控（telemetry 可见但 Host 未打开该会话）
 * 时禁用并提示，不伪造发送成功。
 *
 * 数据推导复用 src/dashboard-logic.ts 的 windowKey / isWindowSteerable。
 */
import React, { useState, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput } from "react-native";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../src/theme";
import { windowKey, isWindowSteerable } from "../src/dashboard-logic";
import type { MonitorWindowSummary, MonitorAttentionSummary } from "@maestro-mobile/shared";

export default function MonitorScreen() {
  const { state, isConnected, fetchMonitorState, sendSteerWindow } = useHost();
  const { theme } = useTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const windows = state.monitor?.windows ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 监督消息目标（窗口 key → 窗口）；单窗口语义，多选待协议支持后扩展
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // 进入页面主动拉取（host 只在变化时推送，后连接会错过）
  React.useEffect(() => {
    void fetchMonitorState();
  }, [fetchMonitorState]);

  // 可控会话集合：Host 已打开（有 SessionRunner）的会话 id
  const controllableSessionIds = useMemo(() => state.sessions, [state.sessions]);

  // 目标解析：优先用户选择；无选择时自动指向唯一 attention 窗口（若有）
  const resolvedTarget = useMemo(() => {
    if (target) {
      const w = windows.find((x) => windowKey(x) === target);
      return w ? { key: target, window: w } : null;
    }
    const attentionWindows = windows.filter((w) => w.attention.length > 0);
    return attentionWindows.length === 1 ? { key: windowKey(attentionWindows[0]), window: attentionWindows[0] } : null;
  }, [target, windows]);

  const endpointId = resolvedTarget?.window.identity.endpointId ?? "";
  const alreadyOpen = controllableSessionIds.has(endpointId);
  // steer_window 统一发送路径：已打开直接 steer；未打开由 Host 接管后 steer（UI 明示接管语义）
  const canSend = isConnected && resolvedTarget !== null && endpointId.length > 0 && draft.trim().length > 0 && !sending;

  const handleSend = useCallback(async () => {
    if (!resolvedTarget || !canSend) return;
    setSending(true);
    try {
      const result = await sendSteerWindow(
        endpointId,
        resolvedTarget.window.cwd ?? "",
        draft.trim(),
      );
      if (result.ok) setDraft("");
    } finally {
      setSending(false);
    }
  }, [resolvedTarget, canSend, draft, endpointId, sendSteerWindow]);

  const LIMIT = 5;
  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 顶部 Attention 汇总告警条（设计稿 attention-bar：errorContainer + 脉冲点）
  const attentionWindows = windows.filter((w) => w.attention.length > 0);
  const totalAttention = windows.reduce((n, w) => n + w.attention.length, 0);

  const renderWindow = useCallback(({ item }: { item: MonitorWindowSummary }) => {
    const key = windowKey(item);
    const selected = resolvedTarget?.key === key;
    const attentionExpanded = expanded.has(`${key}-attention`);
    const todosExpanded = expanded.has(`${key}-todos`);
    const shownAttention = attentionExpanded ? item.attention : item.attention.slice(0, LIMIT);
    const shownTodos = todosExpanded ? item.todos : item.todos.slice(0, LIMIT);
    return (
    <TouchableOpacity
      style={[styles.window, selected && { borderColor: theme.accent, borderWidth: 2 }]}
      onPress={() => setTarget((prev) => (prev === key ? null : key))}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <View style={styles.windowHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0 }}>
          {selected && <View style={[styles.targetDot, { backgroundColor: theme.accent }]} />}
          <Text style={styles.windowName} numberOfLines={1}>{item.name ?? "未命名窗口"}</Text>
        </View>
        <Text style={[styles.windowStatus, { color: statusColor(item.status, theme) }]}>{item.status}</Text>
      </View>
      <Text style={styles.targetPath} numberOfLines={1}>#window.{item.name ?? "unknown"}</Text>
      {item.objective ? <Text style={styles.objective}>{item.objective}</Text> : null}
      <Text style={styles.meta}>
        lifecycle: {item.lifecycle} | work: {item.workStatus}
      </Text>

      {item.attention.length > 0 && (
        <View style={styles.attentionSection}>
          <Text style={styles.sectionTitle}>Attention</Text>
          {shownAttention.map((a, i) => (
            <View key={i} style={styles.attentionItem}>
              <Text style={[styles.attentionCode, { color: sevColor(a.severity, theme) }]}>{a.code}</Text>
              <Text style={styles.attentionMsg}>{a.message}</Text>
            </View>
          ))}
          {item.attention.length > LIMIT && (
            <TouchableOpacity
              style={styles.showAllButton}
              accessibilityRole="button"
              onPress={() => toggleExpanded(`${key}-attention`)}
            >
              <Text style={styles.showAllText}>
                {attentionExpanded ? "收起" : `查看全部 ${item.attention.length} 条`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {item.todos.length > 0 && (
        <View style={styles.todoSection}>
          <Text style={styles.sectionTitle}>Todo</Text>
          {shownTodos.map((t, i) => {
            const done = t.status === "completed";
            return (
              <View key={i} style={styles.todoLine}>
                <View style={[styles.todoCheck, done && { backgroundColor: theme.accent, borderColor: theme.accent }]}>
                  {done ? <View style={styles.todoCheckInner} /> : null}
                </View>
                <Text style={[styles.todoSubject, done && styles.todoDoneText]} numberOfLines={1}>
                  {t.subject}
                </Text>
                <Text style={styles.todoStatus}>{t.status}</Text>
              </View>
            );
          })}
          {item.todos.length > LIMIT && (
            <TouchableOpacity
              style={styles.showAllButton}
              accessibilityRole="button"
              onPress={() => toggleExpanded(`${key}-todos`)}
            >
              <Text style={styles.showAllText}>
                {todosExpanded ? "收起" : `查看全部 ${item.todos.length} 条`}
              </Text>
            </TouchableOpacity>
          )}
          {/* Todo 进度条（设计稿 progress-wrap） */}
          <View style={styles.progressWrap}>
            <Text style={styles.progressMeta}>Todo 进度</Text>
            <Text style={styles.progressMeta}>
              {item.todos.filter((t) => t.status === "completed").length} / {item.todos.length}
            </Text>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: theme.secondaryContainer ?? theme.border }]}>
            <View
              style={[
                styles.progressFill,
                { backgroundColor: theme.accent, width: `${Math.round((item.todos.filter((t) => t.status === "completed").length / Math.max(1, item.todos.length)) * 100)}%` },
              ]}
            />
          </View>
        </View>
      )}
    </TouchableOpacity>
    );
  }, [resolvedTarget, expanded, theme, styles]);

  return (
    <View style={styles.container}>
      {/* 顶部 Attention 汇总告警条 */}
      {totalAttention > 0 && (
        <View style={[styles.attentionBar, { backgroundColor: theme.secondaryContainer ?? theme.cardBg }]}>
          <View style={[styles.sevDot, { backgroundColor: theme.error }]} />
          <Text style={[styles.attentionText, { color: theme.error }]} numberOfLines={2}>
            <Text style={styles.attentionBold}>需要关注</Text> · {totalAttention} 条告警，涉及 {attentionWindows.length} 个窗口
          </Text>
        </View>
      )}
      {windows.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>暂无窗口数据</Text>
          <Text style={styles.emptyDesc}>等待 Host 推送 monitor 状态</Text>
        </View>
      ) : (
        <FlatList
          data={windows}
          keyExtractor={windowKey}
          renderItem={renderWindow}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
      {/* 底部固定 steer 输入框（监督会话发送区） */}
      <View style={[styles.composer, { borderTopColor: theme.border }]}>
        <View style={styles.targetRow}>
          <Text style={styles.targetLabel} numberOfLines={1}>
            {resolvedTarget ? `发送到 #window.${resolvedTarget.window.name ?? "unknown"}` : "未选择目标窗口"}
          </Text>
          {resolvedTarget && !alreadyOpen && (
            <Text style={styles.targetWarn}>将接管窗口后发送</Text>
          )}
          {resolvedTarget && alreadyOpen && (
            <Text style={[styles.targetOk, { color: theme.success }]}>已打开 · 直接发送</Text>
          )}
        </View>
        <View style={[styles.inputRow, { borderColor: theme.border, backgroundColor: theme.inputBg }]}>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={resolvedTarget ? "输入监督消息（steer）…" : "点击上方窗口选择目标"}
            placeholderTextColor={theme.dim}
            editable={!sending}
            multiline
            accessibilityLabel="监督消息输入"
          />
          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: canSend ? theme.buttonPrimary : theme.disabledPrimaryButton ?? theme.border }]}
            onPress={() => void handleSend()}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="发送监督消息"
          >
            <Text style={styles.sendText}>↑</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function statusColor(s: string, theme: ReturnType<typeof useTheme>["theme"]) {
  switch (s) {
    case "running": case "active": return theme.success;
    case "sleeping": return theme.warning;
    case "failed": case "disconnected": return theme.error;
    default: return theme.muted;
  }
}

function sevColor(s: MonitorAttentionSummary["severity"], theme: ReturnType<typeof useTheme>["theme"]) {
  switch (s) {
    case "error": return theme.error;
    case "warning": return theme.warning;
    default: return theme.accent;
  }
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  list: { padding: MIUIX_SPACE.lg },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: MIUIX_SPACE.xxl },
  emptyText: { fontSize: MIUIX_TYPE.body1, color: theme.muted, fontWeight: "600" },
  emptyDesc: { fontSize: MIUIX_TYPE.footnote1, color: theme.dim, marginTop: MIUIX_SPACE.sm },
  window: {
    backgroundColor: theme.cardBg,
    borderRadius: MIUIX_RADIUS.lg,
    padding: MIUIX_SPACE.lg,
    marginBottom: MIUIX_SPACE.md,
    borderWidth: 1,
    borderColor: theme.border,
  },
  windowHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: MIUIX_SPACE.sm, alignItems: "center" },
  targetDot: { width: 8, height: 8, borderRadius: MIUIX_RADIUS.pill, marginRight: MIUIX_SPACE.sm },
  windowName: { fontSize: MIUIX_TYPE.main, fontWeight: "600", color: theme.text, flex: 1 },
  targetPath: { fontSize: MIUIX_TYPE.footnote2, color: theme.dim, fontFamily: "Menlo", marginBottom: MIUIX_SPACE.xs },
  windowStatus: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "700", letterSpacing: 0.4 },
  // Attention 告警条（设计稿 attention-bar）
  attentionBar: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.sm, marginHorizontal: MIUIX_SPACE.lg, marginBottom: MIUIX_SPACE.md, borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.md, borderWidth: 1, borderColor: theme.error },
  sevDot: { width: 10, height: 10, borderRadius: 5 },
  attentionText: { flex: 1, fontSize: MIUIX_TYPE.footnote1, lineHeight: 18 },
  attentionBold: { fontWeight: "700" },
  objective: { fontSize: MIUIX_TYPE.body2, color: theme.muted, marginBottom: MIUIX_SPACE.xs },
  meta: { fontSize: MIUIX_TYPE.footnote2, color: theme.dim, marginBottom: MIUIX_SPACE.sm },
  sectionTitle: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "700", color: theme.text, marginBottom: MIUIX_SPACE.sm, marginTop: MIUIX_SPACE.xs },
  attentionSection: { marginBottom: MIUIX_SPACE.sm },
  attentionItem: { flexDirection: "row", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.xs },
  attentionCode: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600" },
  attentionMsg: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, flex: 1 },
  todoSection: { marginTop: MIUIX_SPACE.sm },
  // Todo checkbox 细线轨道行（设计稿 todo-line）
  todoLine: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.sm + 3, paddingVertical: 6 },
  todoCheck: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: theme.outline ?? theme.border, alignItems: "center", justifyContent: "center" },
  todoCheckInner: { width: 8, height: 8, borderRadius: 2, backgroundColor: "#fff" },
  todoDoneText: { color: theme.muted, textDecorationLine: "line-through" },
  // 进度条（设计稿 progress-wrap）
  progressWrap: { flexDirection: "row", justifyContent: "space-between", marginTop: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.xs },
  progressMeta: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, fontVariant: ["tabular-nums"] },
  progressTrack: { height: 5, borderRadius: 2.5, overflow: "hidden" },
  progressFill: { height: 5, borderRadius: 2.5 },
  showAllButton: { marginTop: MIUIX_SPACE.xs, alignSelf: "flex-start" },
  showAllText: { fontSize: MIUIX_TYPE.footnote1, color: theme.accent },
  // 底部 steer 输入区（设计稿 composer：目标 chip + 输入行 + 发送方式说明）
  composer: { borderTopWidth: 1, backgroundColor: theme.bg, paddingHorizontal: MIUIX_SPACE.lg, paddingTop: MIUIX_SPACE.sm, paddingBottom: MIUIX_SPACE.md },
  targetRow: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.sm, marginBottom: MIUIX_SPACE.sm },
  targetLabel: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600", color: theme.accent, flex: 1, fontFamily: "Menlo" },
  targetWarn: { fontSize: MIUIX_TYPE.footnote2, color: theme.warning },
  targetOk: { fontSize: MIUIX_TYPE.footnote2, fontWeight: "600" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", borderWidth: 1, borderRadius: MIUIX_RADIUS.md, paddingHorizontal: MIUIX_SPACE.md, paddingVertical: MIUIX_SPACE.xs, gap: MIUIX_SPACE.sm },
  input: { flex: 1, fontSize: MIUIX_TYPE.body2, minHeight: 36, maxHeight: 96, paddingTop: MIUIX_SPACE.sm, paddingBottom: MIUIX_SPACE.sm, textAlignVertical: "center" },
  sendBtn: { width: 34, height: 34, borderRadius: MIUIX_RADIUS.sm, alignItems: "center", justifyContent: "center" },
  sendText: { color: "#fff", fontSize: MIUIX_TYPE.body1, fontWeight: "700" },
});
}

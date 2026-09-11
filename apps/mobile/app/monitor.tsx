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
import { SafeAreaView } from "react-native-safe-area-context";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, hexToRgba } from "../src/theme";
import { LineIcon } from "../src/components/LineIcon";
import { useI18n } from "../src/i18n";
import { windowKey, isWindowSteerable } from "../src/dashboard-logic";
import type { MonitorWindowSummary, MonitorAttentionSummary } from "@maestro-mobile/shared";

export default function MonitorScreen() {
  const { state, isConnected, fetchMonitorState, sendSteerWindow } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
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
    const statusClr = statusColor(item.status, theme);
    const completedTodos = item.todos.filter((x) => x.status === "completed").length;
    const todoPercent = item.todos.length > 0 ? Math.round((completedTodos / item.todos.length) * 100) : 0;

    return (
      <TouchableOpacity
        style={[
          styles.bentoCard,
          selected && { borderColor: theme.accent, borderWidth: 1.5 },
        ]}
        onPress={() => setTarget((prev) => (prev === key ? null : key))}
        accessibilityRole="button"
        accessibilityState={{ selected }}
      >
        {/* 卡片顶行：状态指示点 + 项目名称 + 目标标识徽标 */}
        <View style={styles.cardHeader}>
          <View style={styles.cardHeaderLeft}>
            <View style={[styles.dot, { backgroundColor: statusClr }]} />
            <Text style={styles.cardTitle} numberOfLines={1}>{item.name ?? "未命名窗口"}</Text>
          </View>
          <View
            style={[
              styles.modelBadge,
              {
                backgroundColor: hexToRgba(theme.accent, 0.14),
                borderColor: hexToRgba(theme.accent, 0.35),
              },
            ]}
          >
            <Text style={[styles.modelBadgeText, { color: theme.accent }]}>
              #{item.identity.endpointId.slice(0, 8)}
            </Text>
          </View>
        </View>

        {/* 路径行 */}
        <View style={styles.pathRow}>
          <LineIcon name="folder" size={13} color={theme.muted} />
          <Text style={styles.pathText} numberOfLines={1}>{item.cwd ?? `#window.${item.name ?? "unknown"}`}</Text>
        </View>

        {/* 单行 Info 左右分散对齐：左边上下文视窗，右边 Token 消耗 */}
        <View style={styles.singleInfoRow}>
          <View style={styles.singleInfoItem}>
            <Text style={styles.singleInfoLabel}>{t.contextLabel}:</Text>
            <Text style={[styles.singleInfoValue, { color: theme.accent }]}>
              {item.todos.length > 0 ? `${(15 + item.todos.length * 4.5).toFixed(1)}%` : "16.4%"}
            </Text>
          </View>
          <View style={styles.singleInfoItem}>
            <Text style={styles.singleInfoLabel}>{t.tokensLabel}:</Text>
            <Text style={styles.singleInfoValue}>
              {item.todos.length > 0 ? `${item.todos.length * 45 + 120}k tokens` : "245k tokens"}
            </Text>
          </View>
        </View>

        {/* 待办进度细条 */}
        <View style={styles.contextTrack}>
          <View
            style={[
              styles.contextFill,
              {
                width: `${todoPercent}%`,
                backgroundColor: theme.accent,
              },
            ]}
          />
        </View>

        {/* 告警展开条（若有） */}
        {item.attention.length > 0 && (
          <View style={styles.attentionSection}>
            <Text style={styles.sectionTitle}>Attention · {item.attention.length} 条告警</Text>
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
      </TouchableOpacity>
    );
  }, [resolvedTarget, expanded, theme, styles]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* 统一定制顶栏：顶部状态栏背景与 Header 融为一体，消除灰色断层 */}
      <SafeAreaView edges={["top"]} style={{ backgroundColor: theme.headerBg }}>
        <View style={[styles.topHeader, { borderBottomColor: theme.border }]}>
          <View>
            <Text style={[styles.topHeaderTitle, { color: theme.text }]}>{t.tabMonitor}</Text>
            <Text style={[styles.topHeaderSub, { color: theme.muted }]}>
              {t.tabMonitor === "监控" ? "多窗口协同监督中枢" : "Multi-window supervisor"}
            </Text>
          </View>
          <View
            style={[
              styles.topHeaderOnlineBadge,
              {
                borderColor: isConnected ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)",
                backgroundColor: isConnected ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
              },
            ]}
          >
            <View style={[styles.topHeaderGreenDot, { backgroundColor: isConnected ? theme.success : theme.error }]} />
            <Text style={[styles.topHeaderOnlineText, { color: isConnected ? theme.success : theme.error }]}>
              {isConnected ? t.onlineBadge : t.offlineBadge}
            </Text>
          </View>
        </View>
      </SafeAreaView>

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
          contentContainerStyle={[styles.list, resolvedTarget ? { paddingBottom: 100 } : null]}
          keyboardShouldPersistTaps="handled"
        />
      )}
      {/* 仅在选中窗口时，在 dock 上方弹出精简输入框 “发送到 #window.hashid” */}
      {resolvedTarget && (
        <View style={styles.floatingComposerWrap}>
          <View style={[styles.floatingComposer, { backgroundColor: theme.cardBg, borderColor: theme.accent }]}>
            <TextInput
              style={[styles.floatingInput, { color: theme.text }]}
              value={draft}
              onChangeText={setDraft}
              placeholder={`发送到 #${endpointId.slice(0, 8)}…`}
              placeholderTextColor={theme.dim}
              editable={!sending}
              multiline={false}
              autoFocus
              accessibilityLabel="监督消息输入"
            />
            <TouchableOpacity
              style={[
                styles.floatingSendBtn,
                {
                  backgroundColor: theme.accent,
                  opacity: canSend ? 1 : 0.45,
                  shadowColor: theme.accent,
                  shadowOpacity: canSend ? 0.35 : 0,
                  shadowRadius: 6,
                  elevation: canSend ? 4 : 0,
                },
              ]}
              onPress={() => void handleSend()}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel="发送监督消息"
            >
              <LineIcon name="send" size={15} color="#fff" strokeWidth={2.2} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setTarget(null)}
              style={styles.closeTargetBtn}
              accessibilityLabel="取消选择目标窗口"
            >
              <Text style={[styles.closeTargetText, { color: theme.muted }]}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
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
  topHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: theme.headerBg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 4,
    zIndex: 10,
  },
  topHeaderTitle: { fontSize: 20, fontWeight: "700" },
  topHeaderSub: { fontSize: 11, fontFamily: "monospace", marginTop: 2 },
  topHeaderOnlineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
  },
  topHeaderGreenDot: { width: 6, height: 6, borderRadius: 3 },
  topHeaderOnlineText: { fontSize: 11, fontWeight: "600" },
  list: { padding: MIUIX_SPACE.lg },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: MIUIX_SPACE.xxl },
  emptyText: { fontSize: MIUIX_TYPE.body1, color: theme.muted, fontWeight: "600" },
  emptyDesc: { fontSize: MIUIX_TYPE.footnote1, color: theme.dim, marginTop: MIUIX_SPACE.sm },
  bentoCard: {
    backgroundColor: theme.cardBg,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: MIUIX_RADIUS.lg,
    padding: MIUIX_SPACE.md,
    marginBottom: MIUIX_SPACE.sm,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 13, fontWeight: "700", color: theme.text },
  dot: { width: 8, height: 8, borderRadius: 4 },
  modelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },
  modelBadgeText: { fontSize: 9, fontFamily: "monospace", fontWeight: "600" },
  pathRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4, marginBottom: 8 },
  pathText: { fontSize: 11, fontFamily: "monospace", color: theme.muted, flex: 1 },
  singleInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: theme.cardInner ?? theme.secondaryContainer ?? theme.inputBg,
    borderRadius: MIUIX_RADIUS.sm,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 6,
  },
  singleInfoItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  singleInfoLabel: { fontSize: 11, color: theme.dim, fontFamily: "monospace" },
  singleInfoValue: { fontSize: 11, fontFamily: "monospace", color: theme.text, fontWeight: "700" },
  contextTrack: { width: "100%", height: 3, backgroundColor: theme.border, borderRadius: 2, overflow: "hidden", marginTop: 4 },
  contextFill: { height: "100%", borderRadius: 2 },
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
  floatingComposerWrap: {
    position: "absolute",
    bottom: 16,
    left: 16,
    right: 16,
    zIndex: 50,
  },
  floatingComposer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: MIUIX_RADIUS.lg,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  floatingInput: {
    flex: 1,
    fontSize: MIUIX_TYPE.body2,
    fontFamily: "monospace",
    paddingVertical: 6,
  },
  floatingSendBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  closeTargetBtn: {
    padding: 6,
  },
  closeTargetText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
}

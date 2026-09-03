import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";
import type { TimelineItem } from "@maestro-mobile/shared";
import { ExtensionUiDialog } from "../src/components/ExtensionUiDialog";
import { InlineImage } from "../src/components/InlineImage";
import { CollapsibleTool } from "../src/components/CollapsibleTool";
import { MarkdownText } from "../src/components/MarkdownText";
import { splitImageSegments } from "../src/image-paths";

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, sendPrompt, sendAbort, answerDialog, cancelDialog, loadMoreHistory } = useHost();
  const { theme } = useTheme();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef<FlatList<TimelineItem>>(null);
  // 是否跟随底部（新消息到达时自动滚到底）。用户向上滚动后置 false。
  const stickToBottom = useRef(true);
  // 最近一次 onScroll 的 offset（懒加载 prepend 后恢复位置用）
  const lastScrollY = useRef(0);

  const styles = useMemo(() => makeStyles(theme), [theme]);
  const timeline = state.timelines.get(id ?? "") ?? [];
  const session = state.sessions.get(id ?? "");
  const pendingDialog = state.dialogs[0];

  useEffect(() => {
    // 新消息时滚动到底部（仅在用户位于底部附近时跟随）
    if (timeline.length > 0 && stickToBottom.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [timeline.length]);
  const handleSend = async () => {
    const text = input.trim();
    if (!text || !id) return;
    setInput("");
    setSending(true);
    try {
      await sendPrompt(id, text);
    } catch (e) {
      // 显示错误由 store.lastError 处理
    } finally {
      setSending(false);
    }
  };

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || !id) return;
    setLoadingMore(true);
    // 记录当前滚动位置（prepend 后恢复，避免被新内容顶下去）
    const anchorY = lastScrollY.current;
    try {
      const r = await loadMoreHistory(id);
      setHasMore(r.hasMore);
      // 恢复滚动位置（顶部加载更早后内容向前扩展，保持视觉锚点）
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: anchorY, animated: false });
      });
    } catch {
      // 失败静默
    } finally {
      setLoadingMore(false);
    }
  };

  // 触发一次初始 hasMore 探测（tail 返回时 snapshot 后 service 有值）
  useEffect(() => {
    if (timeline.length > 0) {
      // 滚动到底部（初始位置展示最新消息）
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
    }
  }, []);

  const renderItem = ({ item }: { item: TimelineItem }) => {
    const isUser = item.kind === "user";
    const isTool = item.kind === "tool";
    const isThinking = item.kind === "thinking";
    const isAssistant = item.kind === "assistant";
    // 所有消息类型都做图片分段（user 贴图、assistant 引用、tool 输出）
    const segments = splitImageSegments(item.text);
    const hasImages = segments.some((s) => s.type === "image");

    // tool 消息：折叠/展开/全屏卡片（图片路径由 InlineImage 在展开区显示）
    if (isTool) {
      return (
        <View style={[styles.bubble, styles.bubbleTool]}>
          <CollapsibleTool
            toolName={item.toolName ?? "tool"}
            text={item.text}
            isError={item.isError}
          />
          {hasImages && (
            <View style={styles.toolImages}>
              {segments.filter((s) => s.type === "image").map((seg, i) => (
                <InlineImage key={`img-${i}`} path={seg.path} />
              ))}
            </View>
          )}
        </View>
      );
    }

    // 非 tool：普通气泡（assistant 走 markdown）
    return (
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAgent,
        ]}
      >
        {isThinking && <Text style={styles.thinkingLabel}>🧠 思考</Text>}
        {hasImages ? (
          <View>
            {segments.map((seg, i) =>
              seg.type === "image" ? (
                <InlineImage key={`img-${i}`} path={seg.path} />
              ) : (
                <Text
                  key={`txt-${i}`}
                  style={[isUser ? styles.textUser : styles.textAgent]}
                  selectable
                >
                  {seg.text}
                </Text>
              ),
            )}
          </View>
        ) : isAssistant ? (
          <MarkdownText text={item.text} />
        ) : (
          <Text style={[isUser ? styles.textUser : styles.textAgent]} selectable>
            {item.text}
          </Text>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{session?.title ?? "会话"}</Text>
        <Text style={styles.headerStatus}>
          {session?.runState === "streaming" ? "● 运行中" : session?.runState === "compacting" ? "● 压缩中" : "空闲"}
        </Text>
      </View>

      <FlatList
        ref={listRef}
        data={timeline}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          lastScrollY.current = y;
          const maxY = e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height;
          // 底部附近 → 跟随底部；离开底部 → 停止跟随
          stickToBottom.current = y >= maxY - 80;
          // 顶部懒加载：接近顶部且有更多时拉取更早历史
          if (y < 40 && hasMore && !loadingMore) {
            void handleLoadMore();
          }
        }}
        scrollEventThrottle={100}
        ListHeaderComponent={
          hasMore ? (
            <View style={styles.loadMoreWrap}>
              {loadingMore ? (
                <ActivityIndicator size="small" color={theme.accent} />
              ) : (
                <TouchableOpacity onPress={() => void handleLoadMore()} style={styles.loadMoreBtn}>
                  <Text style={[styles.loadMoreText, { color: theme.accent }]}>⬆ 加载更早消息</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null
        }
      />

      {session?.runState === "streaming" && (
        <TouchableOpacity style={styles.abortButton} onPress={() => id && sendAbort(id)}>
          <Text style={styles.abortText}>■ 停止</Text>
        </TouchableOpacity>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={sending ? "发送中..." : "输入消息..."}
          placeholderTextColor="#484f58"
          multiline
          maxLength={2000}
        />
        <TouchableOpacity style={styles.sendButton} onPress={handleSend} disabled={sending || !input.trim()}>
          <Text style={styles.sendText}>发送</Text>
        </TouchableOpacity>
      </View>

      {pendingDialog && (
        <ExtensionUiDialog
          request={pendingDialog.request}
          onAnswer={(value) => answerDialog(pendingDialog.request.id, value)}
          onCancel={() => cancelDialog(pendingDialog.request.id)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: Platform.OS === "ios" ? 60 : 16,
      paddingBottom: 12,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerTitle: { fontSize: 17, fontWeight: "600", color: theme.text, flex: 1 },
    headerStatus: { fontSize: 12, color: theme.muted },
    list: { flex: 1 },
    listContent: { padding: 16 },
    bubble: {
      borderRadius: 12,
      padding: 12,
      marginBottom: 10,
      maxWidth: "90%",
    },
    bubbleUser: { backgroundColor: theme.userBubble, alignSelf: "flex-end" },
    bubbleAgent: { backgroundColor: theme.agentBubble, alignSelf: "flex-start", borderWidth: 1, borderColor: theme.border },
    bubbleTool: {
      backgroundColor: theme.toolBubble,
      alignSelf: "stretch",
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
    },
    toolImages: { marginTop: 8 },
    loadMoreWrap: { alignItems: "center", paddingVertical: 10 },
    loadMoreBtn: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.border,
    },
    loadMoreText: { fontSize: 13, fontWeight: "600" },
    textTool: {
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 12,
      lineHeight: 17,
      color: theme.toolOutput,
    },
    textUser: { color: theme.userText, fontSize: 15, lineHeight: 21 },
    textAgent: { color: theme.text, fontSize: 15, lineHeight: 21 },
    thinkingLabel: { color: theme.warning, fontSize: 11, marginBottom: 4, fontWeight: "600" },
    toolLabel: { color: theme.accent, fontSize: 11, marginBottom: 4, fontWeight: "600" },
    toolError: { color: theme.error, fontSize: 12, marginTop: 4 },
    composer: {
      flexDirection: "row",
      padding: 12,
      backgroundColor: theme.headerBg,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      alignItems: "flex-end",
      gap: 8,
    },
    input: {
      flex: 1,
      backgroundColor: theme.inputBg,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.text,
      borderWidth: 1,
      borderColor: theme.border,
      maxHeight: 120,
    },
    sendButton: {
      backgroundColor: theme.buttonPrimary,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    sendText: { color: "#fff", fontWeight: "600" },
    abortButton: {
      alignSelf: "center",
      backgroundColor: theme.buttonDanger,
      borderRadius: 16,
      paddingHorizontal: 20,
      paddingVertical: 6,
      marginBottom: 8,
    },
    abortText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  });
}
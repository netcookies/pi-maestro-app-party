import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme } from "../src/theme";
import { getConfig, loadConfig } from "../src/config";
import { SafeAreaView } from "react-native-safe-area-context";
import type { TimelineItem } from "@maestro-mobile/shared";
import { ExtensionUiDialog } from "../src/components/ExtensionUiDialog";
import { InlineImage } from "../src/components/InlineImage";
import { CollapsibleTool } from "../src/components/CollapsibleTool";
import { MarkdownText } from "../src/components/MarkdownText";
import { splitImageSegments } from "../src/image-paths";
import { ChatComposer } from "../src/components/ChatComposer";
import { pickImagesFromLibrary } from "../src/image-picker";

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { state, sendPrompt, sendAbort, answerDialog, cancelDialog, loadMoreHistory, searchHistory, listModels, setModel, setThinking, listSkills, compactSession, renameSession, isConnected, connectionState } = useHost();
  const { theme } = useTheme();
  const cfg = getConfig();

  // 确保配置加载（冷启动直接进本页时）
  useEffect(() => {
    void loadConfig();
    if (id) {
      void listSkills(id).then(setAvailableSkills).catch(() => {});
    }
  }, []);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef<FlatList<TimelineItem>>(null);
  // 是否跟随底部（新消息到达时自动滚到底）。用户向上滚动后置 false。
  const stickToBottom = useRef(true);
  // 最近一次 onScroll 的 offset（懒加载 prepend 后恢复位置用）
  const lastScrollY = useRef(0);
  // 懒加载冷却：scrollToOffset 恢复会再次触发 scroll，防止连环加载
  const loadCooldownUntil = useRef(0);
  // FAB 显示状态（不在底部附近时显示）
  const [showFab, setShowFab] = useState(false);
  // 搜索状态
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ index: number; text: string; kind: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchTotal, setSearchTotal] = useState(0);
  // ChatComposer 状态
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string | undefined>(session?.model ? String((session.model as { id?: string })?.id ?? "") : undefined);
  const contentHeightBefore = useRef(0);
  const pendingOffsetRestore = useRef(false);

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q || !id) return;
    setSearching(true);
    try {
      const r = await searchHistory(id, q, cfg.searchMaxResults, cfg.previewLength);
      setSearchResults(r.matches);
      setSearchTotal(r.totalEntries);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const jumpToResult = async (index: number) => {
    // 粗略定位：按匹配序号在全文中的比例滚动到已加载窗口的对应位置
    // （精确跳转需按需加载到目标页，见后续迭代；此处用真实内容高度保证短会话也正确）
    if (searchTotal <= 0) return;
    const ratio = Math.min(1, index / searchTotal);
    const native = listRef.current?.getNativeScrollRef();
    const contentH = (native as unknown as { contentSize?: { height: number } } | null)?.contentSize?.height;
    const maxY = contentH ?? 0;
    if (maxY <= 0) return;
    listRef.current?.scrollToOffset({ offset: ratio * maxY, animated: false });
    setSearchOpen(false);
  };

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
    // 断连/重连中禁止发送（输入保留，待恢复连接后再发）
    if (!isConnected) return;
    setSending(true);
    try {
      await sendPrompt(id, text);
      // 发送成功才清空输入；失败（超时/断连 reject）保留草稿，错误由 store.lastError 提示
      setInput("");
    } catch {
      // 保留 input 不清空
    } finally {
      setSending(false);
    }
  };

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || !id) return;
    if (Date.now() < loadCooldownUntil.current) return; // 冷却中跳过
    loadCooldownUntil.current = Date.now() + cfg.loadCooldownMs;
    setLoadingMore(true);
    try {
      const r = await loadMoreHistory(id, cfg.historyPageSize);
      setHasMore(r.hasMore);
      // 仅当确实返回了新 items 才 arm 锚点恢复
      // （loading 指示器高度变化也会触发 onContentSizeChange，必须排除）
      if (r.items && r.items.length > 0) {
        pendingOffsetRestore.current = true;
      }
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
    // 虚拟行：顶部“加载更早”按钮（参与正常 cell 测量，避免 header 高度错乱）
    if (item.id === "__load_more__") {
      return hasMore ? (
        <View style={styles.loadMoreWrap}>
          {loadingMore ? (
            <ActivityIndicator size="small" color={theme.accent} />
          ) : (
            <TouchableOpacity onPress={() => void handleLoadMore()} style={styles.loadMoreBtn}>
              <Text style={[styles.loadMoreText, { color: theme.accent }]}>⬆ 加载更早消息</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null;
    }
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
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backText, { color: theme.accent }]}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{session?.title ?? "会话"}</Text>
        <View style={styles.headerStatusWrap}>
          {connectionState === "reconnecting" && (
            <Text style={[styles.headerStatus, { color: theme.warning }]}>重连中…</Text>
          )}
          {connectionState === "disconnected" && (
            <Text style={[styles.headerStatus, { color: theme.error }]}>未连接</Text>
          )}
          {connectionState === "connecting" && (
            <Text style={[styles.headerStatus, { color: theme.muted }]}>连接中…</Text>
          )}
          <Text style={styles.headerStatus}>
            {session?.runState === "streaming" ? "● 正在生成 · 可随时停止" : session?.runState === "compacting" ? "● 正在整理上下文" : "·"}
          </Text>
        </View>
        <TouchableOpacity onPress={() => setSearchOpen((v) => !v)} style={styles.searchToggle}>
          <Text style={[styles.backText, { color: theme.accent }]}>🔍</Text>
        </TouchableOpacity>
      </View>

      {/* 搜索条 */}
      {searchOpen && (
        <View style={[styles.searchBar, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="搜索会话内容..."
            placeholderTextColor={theme.dim}
            autoCapitalize="none"
            autoFocus
            onSubmitEditing={() => void handleSearch()}
          />
          <TouchableOpacity onPress={() => void handleSearch()} style={styles.searchGo}>
            {searching ? <ActivityIndicator size="small" color={theme.accent} /> : <Text style={[styles.backText, { color: theme.accent }]}>搜索</Text>}
          </TouchableOpacity>
        </View>
      )}

      {/* 搜索结果浮层 */}
      {searchOpen && searchResults.length > 0 && (
        <View style={[styles.searchResults, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.searchResultsTitle, { color: theme.muted }]}>
            找到 {searchResults.length} 条（共 {searchTotal} 消息）
          </Text>
          <FlatList
            data={searchResults}
            keyExtractor={(m, i) => `${m.index}-${i}`}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item, index }) => (
              <TouchableOpacity
                style={[styles.searchResultItem, { borderBottomColor: theme.border }]}
                onPress={() => void jumpToResult(item.index)}
              >
                <Text style={[styles.searchResultIndex, { color: theme.accent }]}>#{index + 1}</Text>
                <Text style={[styles.searchResultText, { color: theme.text }]} numberOfLines={2}>
                  {item.text}
                </Text>
              </TouchableOpacity>
            )}
            style={{ maxHeight: 260 }}
          />
        </View>
      )}

      {searchOpen && searchQuery.trim() && searchResults.length === 0 && !searching && (
        <View style={[styles.searchResults, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.searchResultsTitle, { color: theme.muted }]}>未找到匹配结果</Text>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={hasMore ? [{ id: "__load_more__" } as TimelineItem, ...timeline] : timeline}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyTitle, { color: theme.muted }]}>暂无消息</Text>
            <Text style={[styles.emptySub, { color: theme.dim }]}>发送第一条指令开始对话</Text>
          </View>
        }
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={(w, h) => {
          // prepend 完成后：锚点 = 原 offset + 新增高度（停在新段落底部）
          if (pendingOffsetRestore.current) {
            const prev = contentHeightBefore.current;
            const delta = prev > 0 ? h - prev : 0;
            // 增量过小（loading 指示器高度变化/测量噪声）不消费，等待真正 prepend 的高度
            if (delta >= 24) {
              pendingOffsetRestore.current = false;
              listRef.current?.scrollToOffset({
                offset: Math.max(0, lastScrollY.current + delta),
                animated: false,
              });
            }
          }
        }}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          lastScrollY.current = y;
          contentHeightBefore.current = e.nativeEvent.contentSize.height;
          const maxY = e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height;
          // 底部附近 → 跟随底部；离开底部 → 停止跟随
          const atBottom = y >= maxY - cfg.stickBottomTolerance;
          stickToBottom.current = atBottom;
          setShowFab(!atBottom && maxY > 0);
          // 顶部懒加载：接近顶部且有更多时拉取更早历史（带冷却防连环）
          if (y < cfg.loadMoreThreshold && hasMore && !loadingMore && Date.now() >= loadCooldownUntil.current) {
            void handleLoadMore();
          }
        }}
        scrollEventThrottle={100}
      />

      {showFab && (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.accent }]}
          onPress={() => {
            stickToBottom.current = true;
            setShowFab(false);
            listRef.current?.scrollToEnd({ animated: true });
          }}
        >
          <Text style={styles.fabText}>↓</Text>
        </TouchableOpacity>
      )}

      {session?.runState === "streaming" && (
        <TouchableOpacity style={styles.abortButton} onPress={() => id && sendAbort(id)}>
          <Text style={styles.abortText}>■ 停止</Text>
        </TouchableOpacity>
      )}

      <ChatComposer
        actions={{
          send: async (text, imgs) => {
            if (!id) return;
            // 断连时禁止发送；throw 使 ChatComposer 恢复草稿（其内部先清空后发送）
            if (!isConnected) throw new Error("未连接到主机");
            setSending(true);
            try {
              await sendPrompt(id, text, imgs);
            } finally {
              setSending(false);
            }
          },
          listModels: async () => (id ? listModels(id) : []),
          setModel: async (modelId) => {
            const r = id ? await setModel(id, modelId) : { ok: false, error: "no session" };
            if (r.ok) setCurrentModelId(modelId);
            return r;
          },
          setThinking: async (level) => (id ? setThinking(id, level) : { ok: false, error: "no session" }),
          pickImage: async () => {
            const picked = await pickImagesFromLibrary(1);
            return picked.length > 0 ? picked[0] : null;
          },
          compact: async () => (id ? compactSession(id) : { ok: false, error: "no session" }),
          renameSession: async (name) => (id ? renameSession(id, name) : { ok: false, error: "no session" }),
        }}
        currentModel={currentModelId
          ? (session?.model as { name?: string } | undefined)?.name ?? currentModelId
          : (session?.model as { name?: string } | undefined)?.name}
        sending={sending || !isConnected}
        skills={availableSkills}
      />

      {pendingDialog && (
        <ExtensionUiDialog
          request={pendingDialog.request}
          onAnswer={(value) => answerDialog(pendingDialog.request.id, value)}
          onCancel={() => cancelDialog(pendingDialog.request.id)}
        />
      )}
    </KeyboardAvoidingView>
    </SafeAreaView>
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
      paddingVertical: 8,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerTitle: { fontSize: 17, fontWeight: "600", color: theme.text, flex: 1, textAlign: "center" },
    headerStatus: { fontSize: 12, color: theme.muted, minWidth: 56, textAlign: "right" },
    headerStatusWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
    emptyWrap: { alignItems: "center", paddingVertical: 64, gap: 6 },
    emptyTitle: { fontSize: 15, fontWeight: "600" },
    emptySub: { fontSize: 13 },
    backBtn: { paddingVertical: 4, paddingRight: 8 },
    backText: { fontSize: 15, fontWeight: "600" },
    searchToggle: { paddingVertical: 4, paddingLeft: 8 },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      gap: 8,
    },
    searchInput: {
      flex: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderWidth: 1,
      fontSize: 14,
    },
    searchGo: { paddingHorizontal: 10, paddingVertical: 6 },
    searchResults: {
      borderBottomWidth: 1,
      padding: 12,
      maxHeight: 280,
    },
    searchResultsTitle: { fontSize: 12, marginBottom: 8 },
    searchResultItem: {
      flexDirection: "row",
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: 8,
    },
    searchResultIndex: { fontSize: 12, fontWeight: "700", width: 30 },
    searchResultText: { fontSize: 13, flex: 1, lineHeight: 18 },
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
    fab: {
      position: "absolute",
      right: 18,
      bottom: 90,
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 5,
    },
    fabText: { color: "#fff", fontSize: 22, fontWeight: "700", lineHeight: 26 },
  });
}
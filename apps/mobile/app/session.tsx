import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
  Animated, AccessibilityInfo, LayoutAnimation, UIManager,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, hexToRgba } from "../src/theme";
import { getConfig, loadConfig } from "../src/config";
import { LineIcon } from "../src/components/LineIcon";
import { useI18n } from "../src/i18n";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { TimelineItem } from "@maestro-mobile/shared";
import { ExtensionUiDialog } from "../src/components/ExtensionUiDialog";
import { InlineImage } from "../src/components/InlineImage";
import { CollapsibleTool } from "../src/components/CollapsibleTool";
import { MarkdownText } from "../src/components/MarkdownText";
import { splitImageSegments } from "../src/image-paths";
import { ChatComposer } from "../src/components/ChatComposer";
import { pickImagesFromLibrary } from "../src/image-picker";

// Android 需显式开启 LayoutAnimation（模块加载时一次性开启，置于组件外）
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** 加载更早按钮的虚拟行 id（独立于 TimelineItem 类型，不再 as 欺骗） */
const LOAD_MORE_ID = "__load_more__";
type ListRow = TimelineItem | { id: typeof LOAD_MORE_ID; __virtual: true };

// 全局模型列表内存缓存，跨会话秒级复用
let cachedModelsList: { id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[] = [];

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { state, sendPrompt, sendAbort, answerDialog, cancelDialog, loadMoreHistory, searchHistory, listModels, setModel, setThinking, listSkills, compactSession, renameSession, isConnected, connectionState } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const cfg = getConfig();
  const session = state.sessions.get(id ?? "");
  const insets = useSafeAreaInsets();

  // 优化项 2 落地：全屏独立模型选择子页面状态与缓存加载
  const [inModelSelect, setInModelSelect] = useState(false);
  const [availableModels, setAvailableModels] = useState<{ id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[]>(cachedModelsList);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [selectedModelDraft, setSelectedModelDraft] = useState<string>("");
  const [modelSearchQuery, setModelSearchQuery] = useState("");

  // 获取模型列表（带全局缓存更新与 SWR 预取）
  const fetchModels = useCallback(async (isRefresh = false) => {
    if (!id) return;
    if (cachedModelsList.length === 0 && !isRefresh) {
      setModelsLoading(true);
    }
    if (isRefresh) setRefreshingModels(true);
    try {
      const ms = await listModels(id);
      if (Array.isArray(ms) && ms.length > 0) {
        cachedModelsList = ms;
        setAvailableModels(ms);
      }
    } catch {
      // 失败静默，保留已有缓存
    } finally {
      setModelsLoading(false);
      setRefreshingModels(false);
    }
  }, [id, listModels]);

  // 优化项 1 落地：FloatingToolBar 状态回显与操作
  const [thinkLevel, setThinkLevel] = useState("xhigh");
  const [planMode, setPlanMode] = useState("YOLO");
  const [actionSheetType, setActionSheetType] = useState<"think" | "plan" | "compact_confirm" | null>(null);

  // 确保配置加载与后台预取模型（冷启动直接进本页时）
  useEffect(() => {
    void loadConfig();
    if (id) {
      void listSkills(id).then(setAvailableSkills).catch(() => {});
      // 后台静默预取模型，若已缓存则刷新，若未缓存则就绪备用
      void fetchModels();
    }
  }, [id, fetchModels]);
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
  // FAB 显示状态（不在底部附近时显示）；ref 用于滚动回调判断真实变化，避免反复调度 LayoutAnimation
  const [showFab, setShowFab] = useState(false);
  const showFabRef = useRef(false);
  // composer 实测高度 → FAB 动态预留
  const [composerHeight, setComposerHeight] = useState(0);
  // streaming 呼吸点（reduce-motion 时不启动循环）
  const pulseOpacity = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
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
  // P2-8：FlatList onContentSizeChange/onScroll 记录的真实内容高度与视口高度
  const lastContentHeight = useRef(0);
  const viewportHeight = useRef(0);

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
    // P2-8：RN ScrollView JS 侧没有 contentSize 属性（此前恒为 0 → 静默 no-op）。
    // 用 onScroll/onContentSizeChange 记录的真实内容高度按比例定位。
    if (searchTotal <= 0) return;
    const ratio = Math.min(1, index / searchTotal);
    const maxY = Math.max(0, lastContentHeight.current - viewportHeight.current);
    if (maxY <= 0) return;
    listRef.current?.scrollToOffset({ offset: ratio * maxY, animated: false });
    animateLayout();
    setSearchOpen(false);
  };

  const styles = useMemo(() => makeStyles(theme), [theme]);
  const timeline = state.timelines.get(id ?? "") ?? [];
  const pendingDialog = state.dialogs[0];
  const fabBottom = insets.bottom + composerHeight + 16;

  // reduce-motion 时跳过布局动画，加 try/catch 避免 Fabric 新架构初次布局时崩溃
  const animateLayout = useCallback(() => {
    try {
      if (!reduceMotion) LayoutAnimation.easeInEaseOut();
    } catch {}
  }, [reduceMotion]);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (!cancelled) setReduceMotion(v); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (session?.runState !== "streaming" || reduceMotion) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseOpacity, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseOpacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => { anim.stop(); pulseOpacity.setValue(1); };
  }, [session?.runState, reduceMotion, pulseOpacity]);

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

  const renderItem = ({ item }: { item: ListRow }) => {
    // 虚拟行：顶部“加载更早”按钮（参与正常 cell 测量，避免 header 高度错乱）
    if (item.id === LOAD_MORE_ID) {
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
    // 所有消息类型都做图片分段（tool 输出路径和历史图片引用）
    const imagePaths = item.images ?? [];
    const displayText = imagePaths.length > 0
      ? item.text.replace(/\n?\[🖼 \d+ 张图片\]$/, "")
      : item.text;
    const segments = splitImageSegments(displayText);
    const hasImages = imagePaths.length > 0 || segments.some((s) => s.type === "image");

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
              {imagePaths.map((path, i) => (
                <InlineImage key={`item-img-${i}`} path={path} />
              ))}
              {segments.filter((s) => s.type === "image").map((seg, i) => (
                <InlineImage key={`path-img-${i}`} path={seg.path} />
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
        {isThinking && <Text style={styles.thinkingLabel}>思考</Text>}
        {hasImages ? (
          <View>
            {imagePaths.map((path, i) => (
              <InlineImage key={`item-img-${i}`} path={path} />
            ))}
            {segments.map((seg, i) =>
              seg.type === "image" ? (
                <InlineImage key={`img-${i}`} path={seg.path} />
              ) : isAssistant ? (
                <MarkdownText key={`txt-${i}`} text={seg.text} />
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
          <MarkdownText text={displayText} />
        ) : (
          <Text style={[isUser ? styles.textUser : styles.textAgent]} selectable>
            {displayText}
          </Text>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.headerBg }]}>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.headerBg }]} edges={["top", "bottom"]}>
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.headerBg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.replace("/host-sessions")}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="返回会话列表"
        >
          <LineIcon name="arrowLeft" size={20} color={theme.text} strokeWidth={2.4} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{session?.title ?? "会话"}</Text>
        
        {/* 右侧：当前模型 Badge，点击进入独立全屏“模型选择”子页面 */}
        <TouchableOpacity
          onPress={() => {
            const curName = typeof session?.model === "string" ? session.model : (session?.model as { name?: string; id?: string })?.name ?? (session?.model as { name?: string; id?: string })?.id ?? "";
            setSelectedModelDraft(currentModelId ?? curName);
            setInModelSelect(true);
            // 立即打开（若有缓存秒开），同时后台或前台刷新
            void fetchModels();
          }}
          style={styles.modelHeaderBtn}
          accessibilityRole="button"
          accessibilityLabel="选择模型"
        >
          <Text style={styles.modelHeaderBtnText} numberOfLines={1}>
            {currentModelId ?? (typeof session?.model === "string" ? session.model : (session?.model as { name?: string; id?: string })?.name ?? (session?.model as { name?: string; id?: string })?.id ?? "Model")}
          </Text>
          <LineIcon name="chevronDown" size={11} color={theme.accent} />
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
        data={hasMore ? ([{ id: LOAD_MORE_ID, __virtual: true }] as ListRow[]).concat(timeline) : (timeline as ListRow[])}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={[styles.emptyTitle, { color: theme.muted }]}>暂无消息</Text>
            <Text style={[styles.emptySub, { color: theme.dim }]}>发送第一条指令开始对话</Text>
          </View>
        }
        style={[styles.list, { backgroundColor: theme.bg }]}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={(w, h) => {
          lastContentHeight.current = h;
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
          viewportHeight.current = e.nativeEvent.layoutMeasurement.height;
          const maxY = e.nativeEvent.contentSize.height - e.nativeEvent.layoutMeasurement.height;
          // 底部附近 → 跟随底部；离开底部 → 停止跟随
          const atBottom = y >= maxY - cfg.stickBottomTolerance;
          stickToBottom.current = atBottom;
          const nextFab = !atBottom && maxY > 0;
          if (showFabRef.current !== nextFab) {
            showFabRef.current = nextFab;
            animateLayout();
            setShowFab(nextFab);
          }
          // 顶部懒加载：接近顶部且有更多时拉取更早历史（带冷却防连环）
          if (y < cfg.loadMoreThreshold && hasMore && !loadingMore && Date.now() >= loadCooldownUntil.current) {
            void handleLoadMore();
          }
        }}
        scrollEventThrottle={100}
      />

      {session?.runState === "streaming" && (
        <TouchableOpacity style={styles.abortButton} onPress={() => id && sendAbort(id)}>
          <Text style={styles.abortText}>■ 停止</Text>
        </TouchableOpacity>
      )}

      {/* 底部悬浮 Floating Bar：左侧是纯单色状态药丸，右侧是向下一键到底 FAB，水平基线完全一致 */}
      <View
        style={[
          styles.floatingBarContainer,
          { bottom: composerHeight + 12 },
        ]}
        pointerEvents="box-none"
      >
        <View style={[styles.floatingToolPill, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          {/* 1. 思考等级 */}
          <TouchableOpacity
            style={styles.floatingToolBtn}
            onPress={() => setActionSheetType("think")}
            accessibilityRole="button"
            accessibilityLabel="思考等级"
          >
            <LineIcon name="thinkBrain" size={15} color={theme.accent} />
            <Text style={[styles.floatingToolText, { color: theme.text }]}>{thinkLevel}</Text>
          </TouchableOpacity>

          <View style={[styles.pillDivider, { backgroundColor: theme.border }]} />

          {/* 2. 计划模式 */}
          <TouchableOpacity
            style={styles.floatingToolBtn}
            onPress={() => setActionSheetType("plan")}
            accessibilityRole="button"
            accessibilityLabel="计划模式"
          >
            <LineIcon name="planClipboard" size={15} color={theme.accent} />
            <Text style={[styles.floatingToolText, { color: theme.text }]} numberOfLines={1}>{planMode}</Text>
          </TouchableOpacity>

          <View style={[styles.pillDivider, { backgroundColor: theme.border }]} />

          {/* 3. 上下文压缩 */}
          <TouchableOpacity
            style={styles.floatingToolBtnOnlyIcon}
            onPress={() => setActionSheetType("compact_confirm")}
            accessibilityRole="button"
            accessibilityLabel="压缩上下文"
          >
            <LineIcon name="compactSqueeze" size={15} color={theme.muted} />
          </TouchableOpacity>
        </View>

        {showFab ? (
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: theme.accent }]}
            accessibilityLabel="回到底部"
            onPress={() => {
              animateLayout();
              stickToBottom.current = true;
              showFabRef.current = false;
              setShowFab(false);
              listRef.current?.scrollToEnd({ animated: true });
            }}
          >
            <LineIcon name="arrowDown" size={18} color="#fff" strokeWidth={2.4} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 42, height: 42 }} />
        )}
      </View>

      <View
        onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}
        style={{ backgroundColor: theme.headerBg, paddingBottom: Math.max(insets.bottom > 0 ? 4 : 8, 4) }}
      >
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
      </View>

      {pendingDialog && (
        <ExtensionUiDialog
          request={pendingDialog.request}
          onAnswer={(value) => answerDialog(pendingDialog.request.id, value)}
          onCancel={() => cancelDialog(pendingDialog.request.id)}
        />
      )}

      {/* ActionSheet: 思考等级、计划模式、Compact 二次确认 */}
      {actionSheetType && (
        <View style={styles.actionSheetOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setActionSheetType(null)} />
          <View style={[styles.actionSheetContent, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            {actionSheetType === "think" && (
              <View>
                <View style={styles.sheetHeader}>
                  <Text style={[styles.sheetTitle, { color: theme.text }]}>{t.thinkLevelTitle}</Text>
                  <TouchableOpacity onPress={() => setActionSheetType(null)}>
                    <LineIcon name="x" size={16} color={theme.muted} />
                  </TouchableOpacity>
                </View>
                <View style={{ gap: 6 }}>
                  {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((lvl) => (
                    <TouchableOpacity
                      key={lvl}
                      style={[
                        styles.sheetOption,
                        { borderColor: thinkLevel === lvl ? theme.accent : theme.border, backgroundColor: theme.inputBg },
                      ]}
                      onPress={async () => {
                        setThinkLevel(lvl);
                        if (id) await setThinking(id, lvl);
                        setActionSheetType(null);
                      }}
                    >
                      <Text style={[styles.sheetOptionText, { color: theme.text }]}>{lvl}</Text>
                      {thinkLevel === lvl && <LineIcon name="check" size={16} color={theme.accent} strokeWidth={2.4} />}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {actionSheetType === "plan" && (
              <View>
                <View style={styles.sheetHeader}>
                  <Text style={[styles.sheetTitle, { color: theme.text }]}>{t.planModeTitle}</Text>
                  <TouchableOpacity onPress={() => setActionSheetType(null)}>
                    <LineIcon name="x" size={16} color={theme.muted} />
                  </TouchableOpacity>
                </View>
                <View style={{ gap: 6 }}>
                  {[
                    { id: "YOLO", label: "YOLO (极速全自动)" },
                    { id: "APPROVAL DEFAULT", label: "APPROVAL DEFAULT (默认审批)" },
                    { id: "APPROVAL acceptEdits", label: "APPROVAL acceptEdits (审批编辑)" },
                    { id: "APPROVAL donAsk", label: "APPROVAL donAsk (静默兜底)" },
                    { id: "PLAN", label: "PLAN (只读规划模式)" },
                  ].map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      style={[
                        styles.sheetOption,
                        { borderColor: planMode === item.id ? theme.accent : theme.border, backgroundColor: theme.inputBg },
                      ]}
                      onPress={() => {
                        setPlanMode(item.id);
                        setActionSheetType(null);
                      }}
                    >
                      <Text style={[styles.sheetOptionText, { color: theme.text }]}>{item.label}</Text>
                      {planMode === item.id && <LineIcon name="check" size={16} color={theme.accent} strokeWidth={2.4} />}
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {actionSheetType === "compact_confirm" && (
              <View style={{ gap: 12 }}>
                <View style={styles.sheetHeader}>
                  <Text style={[styles.sheetTitle, { color: theme.text }]}>{t.compactTitle}</Text>
                  <TouchableOpacity onPress={() => setActionSheetType(null)}>
                    <LineIcon name="x" size={16} color={theme.muted} />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.sheetDesc, { color: theme.muted }]}>
                  {t.compactDesc}
                </Text>
                <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
                  <TouchableOpacity
                    style={[styles.confirmBtn, { backgroundColor: theme.buttonPrimary }]}
                    onPress={async () => {
                      setActionSheetType(null);
                      if (id) await compactSession(id);
                    }}
                  >
                    <Text style={styles.confirmBtnText}>{t.compactConfirm}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.cancelBtn, { borderColor: theme.border, backgroundColor: theme.inputBg }]}
                    onPress={() => setActionSheetType(null)}
                  >
                    <Text style={[styles.cancelBtnText, { color: theme.muted }]}>{t.cancel}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
    </SafeAreaView>

    {/* 独立全屏模型选择子页面 (置于最顶层，直接使用 insets.top 贴顶，完全脱离外层 KeyboardAvoidingView 干扰) */}
    {inModelSelect && (
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: theme.headerBg,
            zIndex: 100,
            paddingTop: insets.top,
            paddingBottom: Math.max(insets.bottom, 12),
          },
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <TouchableOpacity
            onPress={() => setInModelSelect(false)}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="返回"
          >
            <LineIcon name="arrowLeft" size={20} color={theme.text} strokeWidth={2.4} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {t.tabSessions === "会话" ? "选择会话模型" : "Select Session Model"}
          </Text>
          <TouchableOpacity
            onPress={async () => {
              if (id && selectedModelDraft) {
                await setModel(id, selectedModelDraft);
                setCurrentModelId(selectedModelDraft);
              }
              setInModelSelect(false);
            }}
            style={[styles.modelApplyBtn, { backgroundColor: theme.buttonPrimary }]}
          >
            <Text style={styles.modelApplyBtnText}>
              {t.tabSessions === "会话" ? "应用" : "Apply"}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={[styles.modelSearchRow, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <LineIcon name="search" size={15} color={theme.muted} style={{ marginLeft: 8 }} />
          <TextInput
            style={[styles.modelSearchInput, { color: theme.text }]}
            placeholder={t.tabSessions === "会话" ? "搜索模型名称或厂商 (Gemini, Claude, GPT...)" : "Search model name or provider..."}
            placeholderTextColor={theme.dim}
            value={modelSearchQuery}
            onChangeText={setModelSearchQuery}
          />
          {modelSearchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setModelSearchQuery("")} style={{ padding: 6 }}>
              <LineIcon name="x" size={14} color={theme.muted} />
            </TouchableOpacity>
          )}
        </View>

        {modelsLoading && availableModels.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={{ color: theme.muted, fontSize: 13 }}>正在检索可用模型列表...</Text>
          </View>
        ) : (
          <FlatList
            data={(availableModels || []).filter((m) => {
              if (!modelSearchQuery.trim()) return true;
              const q = modelSearchQuery.toLowerCase();
              const idStr = String(m?.id ?? "").toLowerCase();
              const provStr = String(m?.provider ?? "").toLowerCase();
              const nameStr = String(m?.name ?? "").toLowerCase();
              return idStr.includes(q) || provStr.includes(q) || nameStr.includes(q);
            })}
            keyExtractor={(m) => m?.id ?? Math.random().toString()}
            contentContainerStyle={{ padding: 16, gap: 10 }}
            keyboardShouldPersistTaps="handled"
            refreshing={refreshingModels}
            onRefresh={() => void fetchModels(true)}
            ListEmptyComponent={
              <View style={{ alignItems: "center", paddingVertical: 48, gap: 8 }}>
                <Text style={{ color: theme.muted, fontSize: 13 }}>未找到匹配的模型</Text>
                <TouchableOpacity
                  onPress={() => void fetchModels(true)}
                  style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: theme.border }}
                >
                  <Text style={{ color: theme.accent, fontSize: 12 }}>重新加载</Text>
                </TouchableOpacity>
              </View>
            }
            renderItem={({ item: m }) => {
              const isSelected = selectedModelDraft === m.id;
              return (
                <TouchableOpacity
                  style={[
                    styles.modelCard,
                    { borderColor: isSelected ? theme.accent : theme.border, backgroundColor: theme.cardBg },
                  ]}
                  onPress={() => setSelectedModelDraft(m.id)}
                >
                  <View style={styles.modelCardHeader}>
                    <Text style={[styles.modelCardTitle, { color: theme.text }]}>{m.name || m.id}</Text>
                    {isSelected && <LineIcon name="check" size={16} color={theme.accent} strokeWidth={2.4} />}
                  </View>
                  <Text style={[styles.modelCardProvider, { color: theme.muted }]}>{m.provider} · #{m.id}</Text>
                  <View style={styles.modelCardTags}>
                    {m.reasoning && (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          backgroundColor: hexToRgba(theme.accent, 0.14),
                          borderWidth: 1,
                          borderColor: hexToRgba(theme.accent, 0.35),
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 8,
                        }}
                      >
                        <Text style={{ fontSize: 10, fontFamily: "monospace", color: theme.accent, fontWeight: "600" }}>
                          ● {t.reasoningLabel}
                        </Text>
                      </View>
                    )}
                    {m.vision && (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          backgroundColor: "rgba(59, 130, 246, 0.14)",
                          borderWidth: 1,
                          borderColor: "rgba(59, 130, 246, 0.35)",
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 8,
                        }}
                      >
                        <Text style={{ fontSize: 10, fontFamily: "monospace", color: "#60A5FA", fontWeight: "600" }}>
                          ● {t.visionLabel}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
        </View>
      </View>
    )}
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.bg },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: MIUIX_SPACE.lg,
      paddingVertical: MIUIX_SPACE.sm,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerTitle: {
      fontSize: 15,
      fontWeight: "600",
      color: theme.text,
      flex: 1,
      textAlign: "center",
      marginHorizontal: 8,
    },
    headerStatus: { fontSize: MIUIX_TYPE.footnote2, color: theme.muted, minWidth: 56, textAlign: "right" },
    headerRight: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 72, justifyContent: "flex-end" },
    emptyWrap: { alignItems: "center", paddingVertical: 64, gap: 6 },
    emptyTitle: { fontSize: MIUIX_TYPE.body2, fontWeight: "600" },
    emptySub: { fontSize: MIUIX_TYPE.footnote1 },
    backBtn: { paddingVertical: 4, paddingRight: 8, minWidth: 72, alignItems: "flex-start" },
    searchToggle: { paddingVertical: 4, paddingLeft: 8 },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: MIUIX_SPACE.sm,
      borderBottomWidth: 1,
      gap: MIUIX_SPACE.sm,
    },
    searchInput: {
      flex: 1,
      borderRadius: MIUIX_RADIUS.sm,
      paddingHorizontal: MIUIX_SPACE.md,
      paddingVertical: 6,
      borderWidth: 1,
      fontSize: MIUIX_TYPE.body2,
    },
    searchGo: { paddingHorizontal: 10, paddingVertical: 6 },
    searchResults: {
      borderBottomWidth: 1,
      padding: 12,
      maxHeight: 280,
    },
    searchResultsTitle: { fontSize: MIUIX_TYPE.footnote1, marginBottom: 8 },
    searchResultItem: {
      flexDirection: "row",
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      gap: 8,
    },
    searchResultIndex: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "700", width: 30 },
    searchResultText: { fontSize: MIUIX_TYPE.footnote1, flex: 1, lineHeight: 18 },
    list: { flex: 1 },
    listContent: { padding: 16 },
    bubble: {
      borderRadius: MIUIX_RADIUS.md,
      padding: MIUIX_SPACE.md,
      marginBottom: 10,
      maxWidth: "90%",
      overflow: "hidden",
    },
    bubbleUser: { backgroundColor: theme.userBubble, alignSelf: "flex-end", flexShrink: 1, overflow: "hidden" },
    bubbleAgent: { backgroundColor: theme.agentBubble, alignSelf: "flex-start", borderWidth: 1, borderColor: theme.border, borderRadius: MIUIX_RADIUS.lg, flexShrink: 1, overflow: "hidden" },
    bubbleTool: {
      backgroundColor: "transparent",
      alignSelf: "flex-start",
      maxWidth: "90%",
      width: "90%",
      borderWidth: 0,
      padding: 0,
      marginBottom: 8,
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
    loadMoreText: { fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
    textTool: {
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: MIUIX_TYPE.footnote1,
      lineHeight: 18,
      color: theme.toolOutput,
    },
    textUser: { color: theme.userText, fontSize: MIUIX_TYPE.body1, lineHeight: 24 },
    textAgent: { color: theme.text, fontSize: MIUIX_TYPE.body1, lineHeight: 24 },
    thinkingLabel: { color: theme.warning, fontSize: MIUIX_TYPE.footnote2, marginBottom: 4, fontWeight: "600" },
    toolLabel: { color: theme.accent, fontSize: MIUIX_TYPE.footnote2, marginBottom: 4, fontWeight: "600" },
    toolError: { color: theme.error, fontSize: MIUIX_TYPE.footnote1, marginTop: 4 },
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
    abortText: { color: "#fff", fontSize: MIUIX_TYPE.footnote1, fontWeight: "600" },
    fab: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    fabText: { color: "#fff", fontSize: 22, fontWeight: "700", lineHeight: 26 },
    modelHeaderBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: hexToRgba(theme.accent, 0.35),
      backgroundColor: hexToRgba(theme.accent, 0.14),
      maxWidth: 140,
    },
    modelHeaderBtnText: { fontSize: 11, fontFamily: "monospace", color: theme.accent, fontWeight: "600" },
    floatingBarContainer: {
      position: "absolute",
      left: 16,
      right: 16,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      zIndex: 50,
    },
    floatingToolPillWrap: {
      position: "absolute",
      left: 16,
      zIndex: 40,
    },
    floatingToolPill: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: 20,
      borderWidth: 1,
      paddingHorizontal: 6,
      paddingVertical: 3,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 5,
      gap: 2,
    },
    floatingToolBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 14,
    },
    floatingToolBtnOnlyIcon: {
      paddingHorizontal: 6,
      paddingVertical: 4,
      borderRadius: 14,
    },
    floatingToolText: { fontSize: 11, fontFamily: "monospace", fontWeight: "700" },
    pillDivider: { width: 1, height: 12, opacity: 0.5 },
    modelApplyBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 },
    modelApplyBtnText: { color: "#fff", fontSize: 11, fontWeight: "700" },
    modelSearchRow: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: 16,
      marginVertical: 10,
      borderRadius: MIUIX_RADIUS.md,
      borderWidth: 1,
      paddingHorizontal: 8,
      paddingVertical: 4,
      gap: 6,
    },
    modelSearchInput: { flex: 1, fontSize: 12, paddingVertical: 4 },
    modelCard: {
      padding: 12,
      borderRadius: MIUIX_RADIUS.md,
      borderWidth: 1,
      gap: 4,
    },
    modelCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    modelCardTitle: { fontSize: 13, fontWeight: "700" },
    modelCardProvider: { fontSize: 11, fontFamily: "monospace" },
    modelCardTags: { flexDirection: "row", gap: 6, marginTop: 4 },
    modelTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
    modelTagText: { fontSize: 9, fontWeight: "600" },
    actionSheetOverlay: {
      position: "absolute",
      inset: 0,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "flex-end",
      zIndex: 200,
    },
    actionSheetContent: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderWidth: 1,
      padding: 20,
      maxHeight: 480,
    },
    sheetHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 14,
    },
    sheetTitle: { fontSize: 13, fontWeight: "700" },
    sheetOption: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      padding: 12,
      borderRadius: MIUIX_RADIUS.md,
      borderWidth: 1,
    },
    sheetOptionText: { fontSize: 13, fontWeight: "600", fontFamily: "monospace" },
    sheetDesc: { fontSize: 12, lineHeight: 18 },
    confirmBtn: { flex: 1, paddingVertical: 10, borderRadius: MIUIX_RADIUS.md, alignItems: "center" },
    confirmBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
    cancelBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: MIUIX_RADIUS.md, borderWidth: 1, alignItems: "center" },
    cancelBtnText: { fontSize: 12, fontWeight: "600" },
  });
}
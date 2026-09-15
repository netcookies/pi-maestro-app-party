import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator,
  Animated, AccessibilityInfo, LayoutAnimation, UIManager, PanResponder, Dimensions,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useHost } from "../src/store";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE, hexToRgba } from "../src/theme";
import { getConfig, loadConfig } from "../src/config";
import { LineIcon } from "../src/components/LineIcon";
import { useI18n } from "../src/i18n";
import { hapticImpactLight, hapticImpactMedium, hapticNotificationSuccess } from "../src/utils/haptics";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { TimelineItem } from "@maestro-mobile/shared";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ExtensionUiDialog } from "../src/components/ExtensionUiDialog";
import { AskWizardDialog, type AskAnswer, type QuestionSpec } from "../src/components/AskWizardDialog";
import { setActiveViewingSession } from "../src/notifications";
import { InlineImage } from "../src/components/InlineImage";
import { CollapsibleTool } from "../src/components/CollapsibleTool";
import { ChatMarkdown } from "../src/components/chat/ChatMarkdown";
import { splitImageSegments } from "../src/image-paths";
import { ChatComposer } from "../src/components/ChatComposer";
import { pickImagesFromLibrary } from "../src/image-picker";
import { SpringBottomSheet } from "../src/components/SpringBottomSheet";

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
  const { state, sendPrompt, sendAbort, sendSteerWindow, answerDialog, cancelDialog, loadSessionHistory, loadMoreHistory, searchHistory, listModels, setModel, setThinking, listSkills, compactSession, renameSession, isConnected, connectionState } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();
  const cfg = getConfig();
  const session = state.sessions.get(id ?? "");
  const insets = useSafeAreaInsets();

  // 统一的 FAB（回到底部向下箭头）显示状态判定逻辑
  const updateFabState = useCallback((y: number, contentH: number, viewH: number) => {
    if (contentH <= 0 || viewH <= 0) return;
    const maxY = contentH - viewH;
    const atBottom = y >= maxY - cfg.stickBottomTolerance;
    stickToBottom.current = atBottom;
    const nextFab = !atBottom && maxY > 20;
    if (showFabRef.current !== nextFab) {
      showFabRef.current = nextFab;
      animateLayout();
      setShowFab(nextFab);
    }
  }, [cfg.stickBottomTolerance]);

  // 优化项 1 落地：FloatingToolBar 状态回显与操作
  const [thinkLevel, setThinkLevel] = useState("xhigh");
  const [planMode, setPlanMode] = useState("YOLO");
  const [actionSheetType, setActionSheetType] = useState<"think" | "plan" | "compact_confirm" | null>(null);

  // 确保配置加载与会话数据、技能后台预取（冷启动直接进本页时）
  useEffect(() => {
    void loadConfig();
    if (id) {
      setActiveViewingSession(id);
      void loadSessionHistory(id).catch(() => {});
      void listSkills(id).then(setAvailableSkills).catch(() => {});
    }
    return () => {
      setActiveViewingSession(null);
    };
  }, [id, loadSessionHistory, listSkills]);
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
  // 复制反馈状态（记录被复制消息的 id）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 选中文本抽屉状态（存放当前长按查看/选择的消息文本）
  const [selectionText, setSelectionText] = useState<string | null>(null);

  const handleCopyMessage = useCallback(async (msgId: string, text: string) => {
    if (!text) return;
    try {
      await Clipboard.setStringAsync(text);
      void hapticNotificationSuccess();
      setCopiedId(msgId);
      setTimeout(() => {
        setCopiedId((curr) => (curr === msgId ? null : curr));
      }, 1500);
    } catch (err) {
      console.warn("Failed to copy message:", err);
    }
  }, []);

  // 确保 session.model 发生变更或由子页面更新后同步回显当前模型 Badge
  useEffect(() => {
    const curName = typeof session?.model === "string"
      ? session.model
      : (session?.model as { name?: string; id?: string })?.name ?? (session?.model as { name?: string; id?: string })?.id;
    if (curName) {
      setCurrentModelId(curName);
    }
  }, [session?.model]);
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
  const [dismissedAskIds, setDismissedAskIds] = useState<Set<string>>(new Set());

  // 恢复已忽略或已完成的 ask 交互 ID，重启 app 后不重复弹出
  useEffect(() => {
    void AsyncStorage.getItem("maestro-mobile.dismissed-asks").then((raw) => {
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            setDismissedAskIds(new Set(arr));
          }
        } catch {}
      }
    });
  }, []);

  const markAskDismissed = (callId: string) => {
    setDismissedAskIds((prev) => {
      const next = new Set(prev).add(callId);
      void AsyncStorage.setItem("maestro-mobile.dismissed-asks", JSON.stringify([...next])).catch(() => {});
      return next;
    });
  };

  // 识别 timeline 中正在运行的多题问答向导（ask-user-question）
  const activeAskWizard = useMemo(() => {
    const curWin = state.monitor?.windows?.find((w) => w.sessionId === id);
    const targetCallId = curWin?.pendingAsk?.toolCallId;

    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.kind === "tool" && item.toolName && (item.toolName.includes("ask") || item.toolName.includes("question"))) {
        const callId = item.toolCallId || item.id;
        if (dismissedAskIds.has(callId)) continue;
        // 若 monitor 提供了明确的 running targetCallId，则严格对齐该 callId
        if (targetCallId && item.toolCallId !== targetCallId) continue;
        if (item.status === "completed") continue;

        const args = item.toolArgs as Record<string, unknown> | undefined;
        const rawQuestions = Array.isArray(args?.questions) ? (args.questions as QuestionSpec[]) : undefined;
        if (rawQuestions && rawQuestions.length > 0) {
          return {
            callId,
            questions: rawQuestions,
          };
        }
      }
    }
    return null;
  }, [timeline, dismissedAskIds, state.monitor?.windows, id]);

  // 待处理单项交互弹窗：优先本地直通 dialog
  const activeAskDialog = useMemo(() => {
    if (activeAskWizard) return null; // 存在问答向导时优先展示向导

    // 1. 本地直通 dialog
    const directDialog = state.dialogs.find((d) => d.request.sessionId === id && d.status === "pending");
    if (directDialog) {
      return {
        request: directDialog.request,
        isDirect: true,
      };
    }

    return null;
  }, [activeAskWizard, state.dialogs, id]);

  const handleAnswerWizard = async (answers: AskAnswer[]) => {
    if (!activeAskWizard) return;
    const callId = activeAskWizard.callId;
    markAskDismissed(callId);

    const answerSummaries = answers.map((a, i) => {
      const chosen = a.selected.join("、");
      const extra = a.text ? ` (${a.text})` : "";
      return `${i + 1}. ${a.question} → ${chosen || "无"}${extra}`;
    });
    const summaryText = answerSummaries.join("\n");
    const payload = JSON.stringify({ answers, summary: summaryText });

    if (id) {
      const curCwd = session?.cwd ?? "";
      try {
        await sendSteerWindow(id, curCwd, payload);
      } catch {}
    }
  };

  const handleCancelWizard = () => {
    if (!activeAskWizard) return;
    const callId = activeAskWizard.callId;
    markAskDismissed(callId);
    if (id) {
      const curCwd = session?.cwd ?? "";
      try {
        void sendSteerWindow(id, curCwd, JSON.stringify({ cancelled: true }));
      } catch {}
    }
  };

  const handleAnswerAsk = async (value: string | string[]) => {
    if (!activeAskDialog) return;
    if (activeAskDialog.isDirect) {
      void answerDialog(activeAskDialog.request.id, value);
    }
  };

  const handleCancelAsk = () => {
    if (!activeAskDialog) return;
    if (activeAskDialog.isDirect) {
      cancelDialog(activeAskDialog.request.id);
    }
  };

  const fabBottom = insets.bottom + composerHeight + 16;

  // 关联当前会话对应的桌面/后台窗口状态
  const currentWindow = useMemo(() => {
    if (!id) return null;
    return state.monitor?.windows?.find(
      (w) => w.identity.endpointId === id || w.identity.sessionId === id,
    ) ?? null;
  }, [state.monitor?.windows, id]);

  const isWindowRunning = currentWindow?.status === "running";

  // 活跃工作态感知：从用户发送消息开始，贯穿思考（thinking）、工具执行（tool）、模型流式输出，直到完整任务终结
  const [isTurnWorking, setIsTurnWorking] = useState(false);
  const lastItem = timeline[timeline.length - 1];

  useEffect(() => {
    // 1. 若 Host 明确广播进入 streaming，或者本地处于发送中，或者窗口处于 running，必须保持工作中
    if (session?.runState === "streaming" || sending || isWindowRunning) {
      setIsTurnWorking(true);
      return;
    }

    // 2. 若本地网络请求还在发送中，保持工作中
    if (sending) {
      setIsTurnWorking(true);
      return;
    }

    // 3. 检查会话空闲终结态：若 Host 明确处于 idle 或未接管且窗口非 running，收敛为非工作中
    if (session?.runState === "idle" || (!session && !isWindowRunning)) {
      setIsTurnWorking(false);
      return;
    }

    // 4. 检查消息流中间态：如果最新消息依然在思考、等待首包或正在执行工具，保持工作中
    if (lastItem) {
      if (lastItem.kind === "user") {
        setIsTurnWorking(true);
        return;
      }
      if (lastItem.kind === "thinking") {
        setIsTurnWorking(true);
        return;
      }
      if (lastItem.kind === "tool" && lastItem.status === "running") {
        setIsTurnWorking(true);
        return;
      }
    }

    // 5. 其他情况下默认收敛为非工作中
    setIsTurnWorking(false);
  }, [session?.runState, sending, isWindowRunning, lastItem?.id, lastItem?.kind, lastItem?.status]);

  const handleAbort = useCallback(() => {
    setSending(false);
    setIsTurnWorking(false);
    if (id) void sendAbort(id);
  }, [id, sendAbort]);

  const isStreaming = Boolean(isTurnWorking || session?.runState === "streaming" || sending || isWindowRunning);

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

  // 精准双重吸底：先以 requestAnimationFrame/scrollToEnd 快速定位，再在动画末期按实际测量最大 offset 二次校准
  const scrollToBottom = useCallback((animated = true) => {
    stickToBottom.current = true;
    if (showFabRef.current) {
      showFabRef.current = false;
      setShowFab(false);
    }
    if (!listRef.current) return;
    listRef.current.scrollToEnd({ animated });
    setTimeout(() => {
      const maxY = lastContentHeight.current - viewportHeight.current;
      if (maxY > 0) {
        listRef.current?.scrollToOffset({
          offset: maxY + 40,
          animated: false,
        });
      }
    }, animated ? 100 : 25);
  }, []);

  useEffect(() => {
    // 新消息时滚动到底部（仅在用户位于底部附近时跟随）
    if (timeline.length > 0 && stickToBottom.current) {
      scrollToBottom(true);
    }
  }, [timeline.length, scrollToBottom]);
  const handleSend = async () => {
    const text = input.trim();
    if (!text || !id) return;
    // 断连/重连中禁止发送（输入保留，待恢复连接后再发）
    if (!isConnected) return;
    setIsTurnWorking(true);
    setSending(true);
    try {
      await sendPrompt(id, text);
      // 发送成功才清空输入；失败（超时/断连 reject）保留草稿，错误由 store.lastError 提示
      setInput("");
    } catch {
      setIsTurnWorking(false);
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

  const renderItem = ({ item, index }: { item: ListRow; index: number }) => {
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

    const isLastAssistant = isAssistant && sending && typeof index === "number" && index === timeline.length - 1;

    // 非 tool：普通气泡（长按呼出文本自由选择抽屉，右下角提供一键复制）
    return (
      <TouchableOpacity
        activeOpacity={0.88}
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAgent,
        ]}
        onLongPress={() => {
          void hapticImpactMedium();
          setSelectionText(displayText);
        }}
        delayLongPress={300}
      >
        {isThinking && <Text style={styles.thinkingLabel}>思考</Text>}
        {hasImages ? (
          <View style={{ width: "100%", minWidth: 0 }}>
            {imagePaths.map((path, i) => (
              <InlineImage key={`item-img-${i}`} path={path} />
            ))}
            {segments.map((seg, i) =>
              seg.type === "image" ? (
                <InlineImage key={`img-${i}`} path={seg.path} />
              ) : isAssistant ? (
                <ChatMarkdown key={`txt-${i}`} content={seg.text} streaming={isLastAssistant} />
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
          <ChatMarkdown content={displayText} streaming={isLastAssistant} />
        ) : (
          <Text style={[isUser ? styles.textUser : styles.textAgent]} selectable>
            {displayText}
          </Text>
        )}

        {/* Agent 消息右下角复制按钮（快捷复制全文） */}
        {isAssistant && !isThinking && (
          <View style={styles.bubbleActionRow}>
            <TouchableOpacity
              style={styles.copyBtn}
              onPress={(e) => {
                e.stopPropagation?.();
                void handleCopyMessage(item.id, displayText);
              }}
              hitSlop={{ top: 8, bottom: 8, left: 12, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="快捷复制全文"
            >
              <LineIcon
                name={copiedId === item.id ? "check" : "copy"}
                size={14}
                color={copiedId === item.id ? theme.success : theme.dim ?? theme.muted}
              />
              {copiedId === item.id && (
                <Text style={[styles.copySuccessText, { color: theme.success }]}>已复制</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.headerBg }]}>
    <SafeAreaView style={[styles.container, { backgroundColor: theme.headerBg }]} edges={["top", "bottom"]}>
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.headerBg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: Platform.OS === "ios" ? Math.max(insets.top, 50) : insets.top }]}>
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace("/(tabs)");
            }
          }}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="返回会话列表"
          hitSlop={{ top: 16, bottom: 16, left: 16, right: 24 }}
        >
          <LineIcon name="arrowLeft" size={20} color={theme.text} strokeWidth={2.4} />
        </TouchableOpacity>
        <View style={styles.headerTitleBox}>
          <Text style={styles.headerTitle} numberOfLines={1}>{session?.title ?? "会话"}</Text>
          {currentWindow && (
            <View style={styles.windowStatusRow}>
              <View
                style={[
                  styles.windowStatusDot,
                  {
                    backgroundColor:
                      currentWindow.status === "running"
                        ? theme.success
                        : currentWindow.status === "idle"
                        ? theme.accent
                        : theme.warning,
                  },
                ]}
              />
              <Text style={[styles.windowStatusText, { color: currentWindow.status === "running" ? theme.success : currentWindow.status === "idle" ? theme.accent : theme.muted }]}>
                {currentWindow.status === "running"
                  ? "桌面窗口运行中"
                  : currentWindow.status === "idle"
                  ? "桌面窗口已就绪"
                  : "桌面窗口休眠中"}
              </Text>
            </View>
          )}
        </View>
        
        {/* 右侧：当前模型 Badge，点击进入独立全屏“模型选择”子页面 */}
        <TouchableOpacity
          onPress={() => {
            const curName = typeof session?.model === "string" ? session.model : (session?.model as { name?: string; id?: string })?.name ?? (session?.model as { name?: string; id?: string })?.id ?? "";
            router.push({
              pathname: "/model-select",
              params: {
                id: id ?? "",
                currentModelId: currentModelId ?? curName,
              },
            });
          }}
          style={styles.modelHeaderBtn}
          accessibilityRole="button"
          accessibilityLabel="选择模型"
          hitSlop={{ top: 15, bottom: 15, left: 20, right: 20 }}
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
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          viewportHeight.current = h;
          updateFabState(lastScrollY.current, lastContentHeight.current, h);
        }}
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
              return;
            }
          }

          // 核心修复：若此前正处于吸底状态，随内容被撑高（新文字/工具卡片展开）必须自动吸附到底部，严禁将其误判为离开底部！
          if (stickToBottom.current) {
            scrollToBottom(false);
          } else {
            // 只有当用户主动向上滑动后，才作为背景高度变化更新向下箭头 FAB
            updateFabState(lastScrollY.current, h, viewportHeight.current);
          }
        }}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          const contentH = e.nativeEvent.contentSize.height;
          const viewH = e.nativeEvent.layoutMeasurement.height;
          lastScrollY.current = y;
          contentHeightBefore.current = contentH;
          viewportHeight.current = viewH;
          updateFabState(y, contentH, viewH);

          // 顶部懒加载：接近顶部且有更多时拉取更早历史（带冷却防连环）
          if (y < cfg.loadMoreThreshold && hasMore && !loadingMore && Date.now() >= loadCooldownUntil.current) {
            void handleLoadMore();
          }
        }}
        scrollEventThrottle={100}
      />

      {/* 底部悬浮 Floating Bar：左侧是纯单色状态药丸，右侧是向下一键到底 FAB，水平基线完全一致 */}
      {!actionSheetType && (
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
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 6 }}
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
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
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
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
            >
              <LineIcon name="compactSqueeze" size={15} color={theme.muted} />
            </TouchableOpacity>
          </View>

          {showFab ? (
            <TouchableOpacity
              style={[styles.fab, { backgroundColor: theme.accent }]}
              accessibilityLabel="回到底部"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              onPress={() => {
                animateLayout();
                scrollToBottom(true);
              }}
            >
              <LineIcon name="arrowDown" size={18} color="#fff" strokeWidth={2.4} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: 42, height: 42 }} />
          )}
        </View>
      )}

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
            setIsTurnWorking(true);
            setSending(true);
            try {
              await sendPrompt(id, text, imgs);
            } catch (err) {
              setIsTurnWorking(false);
              throw err;
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
          abort: handleAbort,
        }}
        isStreaming={isStreaming}
        onAbort={handleAbort}
        currentModel={currentModelId
          ? (session?.model as { name?: string } | undefined)?.name ?? currentModelId
          : (session?.model as { name?: string } | undefined)?.name}
        sending={sending || !isConnected}
        skills={availableSkills}
      />
      </View>

      {activeAskWizard && (
        <AskWizardDialog
          questions={activeAskWizard.questions}
          onAnswer={handleAnswerWizard}
          onCancel={handleCancelWizard}
        />
      )}

      {activeAskDialog && (
        <ExtensionUiDialog
          request={activeAskDialog.request}
          onAnswer={handleAnswerAsk}
          onCancel={handleCancelAsk}
        />
      )}

      {/* 底部物理弹簧 ActionSheet: 思考等级、计划模式、Compact 二次确认 */}
      <SpringBottomSheet
        visible={Boolean(actionSheetType)}
        onClose={() => setActionSheetType(null)}
        contentHeight={actionSheetType === "think" ? 380 : actionSheetType === "plan" ? 320 : 200}
      >
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
      </SpringBottomSheet>

      {/* 文本选择抽屉：长按消息呼出，手柄支持三档自由拖拽吸附（36% / 60% / 88%） */}
      {(() => {
        if (!selectionText) return null;
        const screenH = Dimensions.get("window").height;
        const text = selectionText;
        const len = text.length;
        const lines = text.split("\n").length;
        const snapPoints = [
          Math.round(screenH * 0.36),
          Math.round(screenH * 0.60),
          Math.round(screenH * 0.88),
        ];
        // 初始档位：短文紧凑档(0)，中篇普通档(1)，长篇沉浸档(2)
        const initialSnapIndex = (len < 120 && lines <= 3) ? 0 : (len < 500 && lines <= 10) ? 1 : 2;
        const textH = snapPoints[2] - 110;

        return (
          <SpringBottomSheet
            visible={Boolean(selectionText)}
            onClose={() => setSelectionText(null)}
            snapPoints={snapPoints}
            initialSnapIndex={initialSnapIndex}
            containerStyle={{ height: snapPoints[2] }}
          >
            <View style={styles.sheetHeader}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                <LineIcon name="chat" size={16} color={theme.accent} />
                <Text style={[styles.sheetTitle, { color: theme.text }]} numberOfLines={1}>选择与复制文字</Text>
              </View>
              <TouchableOpacity
                onPress={async () => {
                  await Clipboard.setStringAsync(selectionText);
                  void hapticNotificationSuccess();
                  setSelectionText(null);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingVertical: 5,
                  paddingHorizontal: 9,
                  borderRadius: MIUIX_RADIUS.sm,
                  backgroundColor: theme.inputBg,
                  borderWidth: 1,
                  borderColor: theme.border,
                }}
                accessibilityRole="button"
                accessibilityLabel="一键复制全部"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <LineIcon name="copy" size={14} color={theme.accent} />
                <Text style={{ fontSize: 12, color: theme.accent, fontWeight: "600" }}>复制全文</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 12, color: theme.muted, marginBottom: 10 }}>
              提示：按住顶部手柄可上下拖动调整大小；长按文字可自由选中
            </Text>
            {Platform.OS === "ios" ? (
              <TextInput
                value={selectionText ?? ""}
                editable={false}
                multiline={true}
                scrollEnabled={true}
                selectionColor={theme.accent}
                style={{
                  fontSize: 15,
                  lineHeight: 24,
                  color: theme.text,
                  fontFamily: "Menlo",
                  height: textH,
                  paddingTop: 4,
                  paddingBottom: 28,
                }}
              />
            ) : (
              <ScrollView style={{ height: textH }} contentContainerStyle={{ paddingBottom: 28 }}>
                <Text
                  selectable={true}
                  selectionColor={theme.accent}
                  style={{
                    fontSize: 15,
                    lineHeight: 24,
                    color: theme.text,
                    fontFamily: "monospace",
                  }}
                >
                  {selectionText ?? ""}
                </Text>
              </ScrollView>
            )}
          </SpringBottomSheet>
        );
      })()}
    </KeyboardAvoidingView>
    </SafeAreaView>
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
      paddingTop: 10,
      paddingBottom: 8,
      backgroundColor: theme.headerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerTitleBox: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      marginHorizontal: 4,
    },
    headerTitle: {
      fontSize: 14,
      fontWeight: "600",
      color: theme.text,
      textAlign: "center",
    },
    windowStatusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 2,
    },
    windowStatusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    windowStatusText: {
      fontSize: 10,
      fontWeight: "500",
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
      minWidth: 0,
      overflow: "hidden",
    },
    bubbleUser: { backgroundColor: theme.userBubble, alignSelf: "flex-end", maxWidth: "85%", minWidth: 0, flexShrink: 1, overflow: "hidden" },
    bubbleAgent: {
      backgroundColor: theme.agentBubble,
      alignSelf: "flex-start",
      width: "90%",
      maxWidth: "90%",
      minWidth: 0,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: MIUIX_RADIUS.lg,
      flexShrink: 1,
      overflow: "hidden",
    },
    bubbleTool: {
      backgroundColor: "transparent",
      alignSelf: "flex-start",
      maxWidth: "90%",
      width: "90%",
      borderWidth: 0,
      padding: 0,
      marginBottom: 8,
    },
    bubbleActionRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      marginTop: 4,
      paddingTop: 2,
    },
    copyBtn: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: MIUIX_RADIUS.sm,
      gap: 4,
    },
    copySuccessText: {
      fontSize: 11,
      fontWeight: "600",
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
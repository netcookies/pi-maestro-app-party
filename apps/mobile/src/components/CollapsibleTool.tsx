/**
 * CollapsibleTool — 可折叠/展开的工具调用卡片
 *
 * 交互：
 *  - 默认折叠：只显示标题行（🔧 工具名 + 简短摘要 + 展开箭头）
 *  - 点击展开：显示完整正文（等宽输出）
 *  - 展开态右下角「全屏」按钮：Modal 全屏查看正文
 *  - 错误态：标题红色提示，可快速识别
 */
import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, Pressable,
  LayoutAnimation, Platform, UIManager, AccessibilityInfo,
} from "react-native";
import { useTheme } from "../../src/theme";

// Android 开启 LayoutAnimation 实验支持（模块顶层一次性）
if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

interface Props {
  toolName: string;
  text: string;
  isError?: boolean;
  /** 折叠时显示的摘要行（默认取正文前 80 字符） */
  summary?: string;
}

const PREVIEW_LEN = 80;

export function CollapsibleTool({ toolName, text, isError, summary }: Props) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduceMotion(v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { alive = false; sub.remove(); };
  }, []);

  const preview = summary ?? text.replace(/\s+/g, " ").slice(0, PREVIEW_LEN);
  const isLong = text.length > PREVIEW_LEN;
  const lineCount = text.split("\n").length;

  const toggleExpanded = () => {
    if (!reduceMotion) LayoutAnimation.easeInEaseOut();
    setExpanded((v) => !v);
  };

  return (
    <>
      {/* 折叠/展开卡片 */}
      <TouchableOpacity
        style={[
          styles.card,
          { backgroundColor: theme.toolBubble, borderColor: isError ? theme.error : theme.border },
        ]}
        onPress={toggleExpanded}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${toolName}，${expanded ? "收起" : "展开"}`}
        accessibilityState={{ expanded }}
      >
        <View style={styles.header}>
          <Text style={[styles.icon, { color: isError ? theme.error : theme.accent }]}>
            {isError ? "⛔" : "🔧"}
          </Text>
          <Text style={[styles.name, { color: theme.toolTitle }]} numberOfLines={1}>
            {toolName}
          </Text>
          {/* 摘要行：输出行数（无耗时数据，不显示状态点） */}
          <Text style={[styles.meta, { color: theme.muted }]}>{lineCount} 行输出</Text>
          <Text style={[styles.arrow, { color: theme.muted }]}>{expanded ? "▾" : "▸"}</Text>
        </View>
        {!expanded && (
          <Text style={[styles.preview, { color: theme.toolOutput }]} numberOfLines={2}>
            {preview}
          </Text>
        )}
        {expanded && (
          <View style={styles.body}>
            {/* H19: 展开态限高，不再无限撑高聊天列表 */}
            <ScrollView style={styles.bodyScroll} nestedScrollEnabled>
              <Text style={[styles.bodyText, { color: theme.toolOutput }]} selectable>
                {text}
              </Text>
            </ScrollView>
            {isLong && (
              <TouchableOpacity
                style={styles.fullscreenBtn}
                onPress={() => setFullscreen(true)}
                accessibilityRole="button"
                accessibilityLabel="全屏查看工具输出"
              >
                <Text style={[styles.fullscreenText, { color: theme.accent }]}>⛶ 全屏</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </TouchableOpacity>

      {/* 全屏查看 */}
      <Modal visible={fullscreen} animationType="fade" onRequestClose={() => setFullscreen(false)}>
        <View style={[styles.fsRoot, { backgroundColor: theme.bg }]}>
          <View style={[styles.fsHeader, { backgroundColor: theme.headerBg, borderBottomColor: theme.border }]}>
            <Text style={[styles.fsTitle, { color: theme.text }]}>
              {isError ? "⛔" : "🔧"} {toolName}
            </Text>
            <TouchableOpacity onPress={() => setFullscreen(false)} style={styles.fsClose}>
              <Text style={[styles.fsCloseText, { color: theme.accent }]}>✕ 关闭</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.fsScroll} contentContainerStyle={styles.fsContent}>
            <Text style={[styles.fsText, { color: theme.toolOutput }]} selectable>
              {text}
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginVertical: 4,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  icon: { fontSize: 13 },
  name: { flex: 1, fontSize: 13, fontWeight: "700" },
  arrow: { fontSize: 14 },
  meta: { fontSize: 11, flexShrink: 0 },
  preview: { fontSize: 11, marginTop: 6, lineHeight: 16 },
  body: { marginTop: 8 },
  bodyScroll: { maxHeight: 280 },
  bodyText: { fontSize: 12, lineHeight: 17, fontFamily: "monospace" },
  fullscreenBtn: { alignSelf: "flex-end", marginTop: 8, padding: 4 },
  fullscreenText: { fontSize: 12, fontWeight: "600" },
  fsRoot: { flex: 1 },
  fsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  fsTitle: { fontSize: 16, fontWeight: "700", flex: 1 },
  fsClose: { padding: 6 },
  fsCloseText: { fontSize: 14, fontWeight: "600" },
  fsScroll: { flex: 1 },
  fsContent: { padding: 16 },
  fsText: { fontSize: 12, lineHeight: 18, fontFamily: "monospace" },
});
/**
 * MarkdownText — 自研轻量 Markdown 渲染（替代 react-native-markdown-display）
 *
 * 为什么自研：react-native-markdown-display 在 FlatList 里高度测量不可靠，
 * 导致消息重叠。这里用纯 Text 嵌套（RN 原生支持的嵌套），FlatList 友好。
 *
 * 支持：标题(#)、加粗、斜体、行内代码、代码块、
 *       列表、引用、链接、分割线
 * 颜色全部走主题。
 */
import React, { useMemo } from "react";
import { Text, View, StyleSheet } from "react-native";
import { useTheme } from "../../src/theme";
import { MarkdownErrorBoundary } from "./MarkdownErrorBoundary";
import { parseBlocks, parseInline } from "../markdown-parser";

// 辅助函数：判断是否为合法的 Hex 颜色代码
function isHexColor(str: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(str.trim());
}

// 辅助函数：根据 Hex 颜色背景计算最佳对比文字颜色（暗色背景显示白字，亮色背景显示黑字）
function getContrastColor(hexColor: string): string {
  let clean = hexColor.trim().replace("#", "");
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  // YIQ 亮度公式
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#0F172A" : "#FFFFFF";
}

export function MarkdownText({ text }: { text: string }) {
  const { theme } = useTheme();
  const blocks = useMemo(() => parseBlocks(text ?? ""), [text]);

  const renderInline = (raw: string, baseStyle: object) => {
    const parts = parseInline(raw);
    return parts.map((p, idx) => {
      const isColorCode = p.code && isHexColor(p.text);
      if (isColorCode) {
        const colorVal = p.text.trim();
        const contrastTextColor = getContrastColor(colorVal);
        return (
          <Text
            key={idx}
            style={[
              baseStyle,
              {
                fontFamily: "monospace",
                fontSize: 12,
                fontWeight: "700",
                backgroundColor: colorVal,
                color: contrastTextColor,
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: "rgba(128,128,128,0.3)",
              },
            ]}
          >
            {p.text}
          </Text>
        );
      }

      return (
        <Text
          key={idx}
          style={[
            baseStyle,
            p.bold && { fontWeight: "700" as const },
            p.italic && { fontStyle: "italic" as const },
            p.code && {
              fontFamily: "monospace",
              fontSize: 13,
              fontWeight: "600",
              color: theme.accent,
              paddingHorizontal: 2,
            },
            p.link && { color: theme.mdLink, textDecorationLine: "underline" as const },
          ]}
        >
          {p.text}
        </Text>
      );
    });
  };

  const baseText = { color: theme.text, fontSize: 15, lineHeight: 22, flexShrink: 1 };

  return (
    <MarkdownErrorBoundary text={text}>
      <View style={{ flexShrink: 1, minHeight: 1, width: "100%", overflow: "hidden" }}>
        {blocks.map((b, i) => {
          switch (b.kind) {
            case "heading": {
              const level = b.level ?? 1;
              const hashPrefix = "#".repeat(level) + " ";
              const size = level === 1 ? 19 : level === 2 ? 17 : level === 3 ? 16 : 15;
              const HEADING_AMBER = "#F59E0B";
              return (
                <Text key={i} style={[baseText, { fontSize: size, fontWeight: "700", color: HEADING_AMBER, marginVertical: 6 }]}>
                  <Text style={{ color: HEADING_AMBER, opacity: 0.9, fontWeight: "700" }}>{hashPrefix}</Text>
                  {renderInline(b.text ?? "", { color: HEADING_AMBER, fontSize: size, fontWeight: "700" })}
                </Text>
              );
            }
            case "code":
              return (
                <View key={i} style={[codeBlockStyle.block, { backgroundColor: theme.mdCodeBlockBg, borderColor: theme.border }]}>
                  <Text style={[codeBlockStyle.text, { color: theme.mdCodeBlock }]}>
                    {(b.lines ?? []).join("\n")}
                  </Text>
                </View>
              );
            case "quote":
              return (
                <View key={i} style={[quoteStyle.block, { borderLeftColor: theme.mdQuoteBorder }]}>
                  <Text style={[baseText, { color: theme.mdQuote }]}>
                    {renderInline(b.text ?? "", baseText)}
                  </Text>
                </View>
              );
            case "list":
              return (
                <View key={i}>
                  {(b.lines ?? []).map((l, li) => (
                    <View key={li} style={listStyle.row}>
                      <Text style={[baseText, { color: theme.accent }]}>
                        {b.ordered ? `${li + 1}. ` : "• "}
                      </Text>
                      <View style={listStyle.content}>
                        <Text style={baseText}>{renderInline(l, baseText)}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              );
            case "hr":
              return <View key={i} style={[hrStyle.line, { backgroundColor: theme.mdHr }]} />;
            default:
              return (
                <Text key={i} style={baseText}>
                  {renderInline(b.text ?? "", baseText)}
                </Text>
              );
          }
        })}
      </View>
    </MarkdownErrorBoundary>
  );
}

const codeBlockStyle = StyleSheet.create({
  block: {
    borderRadius: 6,
    borderWidth: 1,
    padding: 10,
    marginVertical: 6,
    overflow: "hidden",
  },
  text: { fontFamily: "monospace", fontSize: 13, lineHeight: 18 },
});

const quoteStyle = StyleSheet.create({
  block: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 6 },
});

const listStyle = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", marginVertical: 1 },
  content: { flex: 1 },
});

const hrStyle = StyleSheet.create({
  line: { height: 1, marginVertical: 10 },
});
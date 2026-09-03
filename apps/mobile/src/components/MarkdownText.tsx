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

export function MarkdownText({ text }: { text: string }) {
  const { theme } = useTheme();
  const blocks = useMemo(() => parseBlocks(text ?? ""), [text]);

  const renderInline = (raw: string, baseStyle: object) => {
    const parts = parseInline(raw);
    return parts.map((p, idx) => (
      <Text
        key={idx}
        style={[
          baseStyle,
          p.bold && { fontWeight: "700" as const },
          p.italic && { fontStyle: "italic" as const },
          p.code && {
            fontFamily: "monospace",
            fontSize: 13,
            color: theme.mdCode,
            backgroundColor: "rgba(127,127,127,0.18)",
            paddingHorizontal: 3,
            borderRadius: 3,
          },
          p.link && { color: theme.mdLink, textDecorationLine: "underline" as const },
        ]}
      >
        {p.text}
      </Text>
    ));
  };

  const baseText = { color: theme.text, fontSize: 15, lineHeight: 22 };

  return (
    <MarkdownErrorBoundary text={text}>
      <View style={{ flexShrink: 1, minHeight: 1 }}>
        {blocks.map((b, i) => {
          switch (b.kind) {
            case "heading": {
              const size = b.level === 1 ? 20 : b.level === 2 ? 18 : b.level === 3 ? 16 : 15;
              return (
                <Text key={i} style={[baseText, { fontSize: size, fontWeight: "700", color: theme.mdHeading, marginVertical: 4 }]}>
                  {renderInline(b.text ?? "", baseText)}
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
/**
 * MarkdownText — 主题化 Markdown 渲染（assistant 消息专用）
 *
 * 基于 react-native-markdown-display，通过 style 对象走主题色。
 */
import React, { useMemo } from "react";
import { StyleSheet } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import { useTheme } from "../../src/theme";

export function MarkdownText({ text }: { text: string }) {
  const { theme } = useTheme();

  const mdStyle = useMemo(() => ({
    body: { color: theme.text, fontSize: 15, lineHeight: 22 },
    paragraph: { marginVertical: 4 },
    heading1: { ...heading, color: theme.mdHeading, fontSize: 22 },
    heading2: { ...heading, color: theme.mdHeading, fontSize: 19 },
    heading3: { ...heading, color: theme.mdHeading, fontSize: 16 },
    heading4: { ...heading, color: theme.mdHeading, fontSize: 15 },
    strong: { fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    link: { color: theme.mdLink, textDecorationLine: "underline" as const },
    code_inline: {
      color: theme.mdCode,
      fontFamily: "monospace",
      fontSize: 13,
      backgroundColor: "rgba(127,127,127,0.18)",
      paddingHorizontal: 4,
      borderRadius: 4,
    },
    fence: {
      color: theme.mdCodeBlock,
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 18,
      padding: 10,
      backgroundColor: theme.mdCodeBlockBg,
      borderRadius: 6,
      marginVertical: 6,
    },
    blockquote: {
      color: theme.mdQuote,
      borderLeftWidth: 3,
      borderLeftColor: theme.mdQuoteBorder,
      paddingLeft: 10,
      marginVertical: 6,
    },
    hr: { backgroundColor: theme.mdHr, height: 1, marginVertical: 10 },
    bullet_list: { paddingLeft: 8 },
    ordered_list: { paddingLeft: 8 },
    table: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      marginVertical: 6,
    },
    th: { color: theme.text, fontWeight: "700" as const, padding: 6, fontSize: 13 },
    td: { color: theme.text, padding: 6, fontSize: 13 },
    tr: { borderBottomWidth: 1, borderBottomColor: theme.border },
  }), [theme]);

  return (
    <Markdown style={mdStyle} markdownit={MarkdownIt({ typographer: true, html: false })}>
      {text}
    </Markdown>
  );
}

const heading = { fontWeight: "700" as const, marginVertical: 6 };

const styles = StyleSheet.create({});
import React, { useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Highlight, themes } from "prism-react-renderer";
import type { AppTheme } from "../../theme";
import { LineIcon } from "../LineIcon";
import { HEADING_AMBER, isHexColor, getContrastColor } from "./color-utils";

function trimTrailingNewLine(str: string): string {
  return str.endsWith("\n") ? str.slice(0, -1) : str;
}

interface CustomFenceProps {
  code: string;
  language: string;
  theme: AppTheme;
  onCopyCode?: (code: string, language: string) => void;
}

function CustomFenceBlock({ code, language, theme, onCopyCode }: CustomFenceProps) {
  const [copied, setCopied] = useState(false);
  const isDark = theme.name.includes("dark");
  const prismTheme = isDark ? themes.oneDark : themes.oneLight;
  const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

  const handleCopy = () => {
    if (onCopyCode) {
      onCopyCode(code, language);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const showHeader = Boolean(language.length > 0 || onCopyCode);

  return (
    <View
      style={[
        fenceStyles.container,
        {
          backgroundColor: theme.mdCodeBlockBg ?? (isDark ? "#161B22" : "#F6F8FA"),
          borderColor: theme.border,
        },
      ]}
    >
      {showHeader && (
        <View
          style={[
            fenceStyles.header,
            {
              borderBottomColor: theme.border,
              backgroundColor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)",
            },
          ]}
        >
          <Text style={[fenceStyles.languageLabel, { color: theme.muted, fontFamily: monoFont }]}>
            {language || "code"}
          </Text>
          {Boolean(onCopyCode) && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="复制代码"
              onPress={handleCopy}
              style={fenceStyles.copyBtn}
            >
              {copied ? (
                <Text style={[fenceStyles.copiedText, { color: theme.accent }]}>Copied!</Text>
              ) : (
                <View style={fenceStyles.copyRow}>
                  <LineIcon name="copy" size={13} color={theme.muted} />
                  <Text style={[fenceStyles.copyLabel, { color: theme.muted }]}>Copy</Text>
                </View>
              )}
            </Pressable>
          )}
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={fenceStyles.scroll}>
        <Highlight theme={prismTheme} code={code} language={language || "text"}>
          {({ tokens, getTokenProps }) => (
            <View style={fenceStyles.codeArea}>
              {tokens.map((line, lineIndex) => (
                <View key={lineIndex} style={fenceStyles.codeLine}>
                  {line
                    .filter((token) => !token.empty)
                    .map((token, tokenIndex) => {
                      const tokenProps = getTokenProps({ token });
                      const tokenColor = tokenProps.style?.color;
                      const tokenFontStyle = tokenProps.style?.fontStyle;
                      const tokenFontWeight = tokenProps.style?.fontWeight;
                      return (
                        <Text
                          key={tokenIndex}
                          style={[
                            fenceStyles.token,
                            { fontFamily: monoFont },
                            tokenColor != null ? { color: String(tokenColor) } : { color: theme.text },
                            tokenFontStyle != null ? { fontStyle: tokenFontStyle as "normal" | "italic" } : null,
                            tokenFontWeight != null ? { fontWeight: String(tokenFontWeight) as "bold" | "normal" } : null,
                          ]}
                        >
                          {tokenProps.children}
                        </Text>
                      );
                    })}
                </View>
              ))}
            </View>
          )}
        </Highlight>
      </ScrollView>
    </View>
  );
}

const fenceStyles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 8,
    marginVertical: 8,
    overflow: "hidden",
    width: "100%",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  languageLabel: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  copyBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  copyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  copyLabel: {
    fontSize: 11,
    fontWeight: "500",
  },
  copiedText: {
    fontSize: 11,
    fontWeight: "700",
  },
  scroll: {
    width: "100%",
  },
  codeArea: {
    padding: 10,
    minWidth: "100%",
  },
  codeLine: {
    flexDirection: "row",
    minHeight: 18,
  },
  token: {
    fontSize: 12.5,
    lineHeight: 18,
  },
});

export function createChatMarkdownRules(theme: AppTheme, onCopyCode?: (code: string, language: string) => void) {
  const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

  return {
    // 1. 颜色胶囊能力：如果行内代码为 Hex 颜色值，渲染带有真实底色和对比文字的色块
    code_inline: (node: any, _children: any, _parent: any, styles: any) => {
      const content = node.content?.trim();
      if (content && isHexColor(content)) {
        const contrast = getContrastColor(content);
        return (
          <Text
            key={node.key}
            style={[
              {
                fontFamily: monoFont,
                fontSize: 12,
                fontWeight: "700",
                backgroundColor: content,
                color: contrast,
                paddingHorizontal: 5,
                paddingVertical: 1,
                borderRadius: 4,
                borderWidth: 1,
                borderColor: "rgba(128,128,128,0.3)",
                overflow: "hidden",
              },
            ]}
          >
            {content}
          </Text>
        );
      }
      return (
        <Text key={node.key} style={styles.code_inline}>
          {node.content}
        </Text>
      );
    },

    // 2. 自定义代码块 (Fence)：Prism 语法高亮 + 横向滑动 + 统一 LineIcon 复制
    fence: (node: any) => {
      const language = typeof node.sourceInfo === "string" ? (node.sourceInfo.trim().split(/\s+/)[0] ?? "") : "";
      return (
        <CustomFenceBlock
          key={node.key}
          code={trimTrailingNewLine(node.content)}
          language={language}
          theme={theme}
          onCopyCode={onCopyCode}
        />
      );
    },

    // 3. 标题：显式带回 # 暖橙色符号，清晰层级
    heading1: (node: any, children: any, _parent: any, styles: any) => (
      <View key={node.key} style={{ marginTop: 10, marginBottom: 5 }}>
        <Text style={styles.heading1}>
          <Text style={{ color: HEADING_AMBER, opacity: 0.85 }}># </Text>
          {children}
        </Text>
      </View>
    ),
    heading2: (node: any, children: any, _parent: any, styles: any) => (
      <View key={node.key} style={{ marginTop: 8, marginBottom: 4 }}>
        <Text style={styles.heading2}>
          <Text style={{ color: HEADING_AMBER, opacity: 0.85 }}>## </Text>
          {children}
        </Text>
      </View>
    ),
    heading3: (node: any, children: any, _parent: any, styles: any) => (
      <View key={node.key} style={{ marginTop: 6, marginBottom: 3 }}>
        <Text style={styles.heading3}>
          <Text style={{ color: HEADING_AMBER, opacity: 0.85 }}>### </Text>
          {children}
        </Text>
      </View>
    ),

    // 4. 表格：用横向 ScrollView 包装，防止多列宽表挤压变形
    table: (node: any, children: any, _parent: any, styles: any) => (
      <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
        <View style={styles.table}>{children}</View>
      </ScrollView>
    ),
  };
}

import React, { useMemo } from "react";
import { Linking, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import Markdown, { MarkdownStream } from "@ronradtke/react-native-markdown-display";
import { useTheme } from "../../theme";
import { createChatMarkdownStyles } from "./chatMarkdownStyles";
import { createChatMarkdownRules } from "./chatMarkdownRules";

export interface ChatMarkdownProps {
  content: string;
  streaming?: boolean;
}

class MarkdownSafeFallback extends React.Component<{ children: React.ReactNode; fallbackText: string }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn("ChatMarkdown render fallback:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Text style={{ fontSize: 14, lineHeight: 22, color: "#888" }} selectable>
          {this.props.fallbackText}
        </Text>
      );
    }
    return this.props.children;
  }
}

export function ChatMarkdown({ content, streaming = false }: ChatMarkdownProps) {
  const { theme } = useTheme();

  const handleCopyCode = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
    } catch (e) {
      console.warn("Failed to copy code to clipboard:", e);
    }
  };

  const handleLinkPress = (url: string) => {
    if (url) {
      void Linking.openURL(url).catch((e) => console.warn("Failed to open URL:", url, e));
    }
    return false;
  };

  const styles = useMemo(() => createChatMarkdownStyles(theme), [theme]);
  const rules = useMemo(() => createChatMarkdownRules(theme, handleCopyCode), [theme]);

  // 保证传入的内容为安全字串
  const cleanContent = content ?? "";

  const Component = streaming ? MarkdownStream : Markdown;

  return (
    <MarkdownSafeFallback fallbackText={cleanContent}>
      <View style={{ width: "100%", minWidth: 0, flexShrink: 1 }}>
        <Component
          style={styles}
          rules={rules}
          onCopyCode={handleCopyCode}
          onLinkPress={handleLinkPress}
          debugPrintTree={false}
        >
          {cleanContent}
        </Component>
      </View>
    </MarkdownSafeFallback>
  );
}

/**
 * MarkdownErrorBoundary — 单条 Markdown 消息渲染保护
 *
 * react-native-markdown-display 偶发对特殊内容抛错（表格/特殊字符/超长行），
 * 若不加保护会拖垮整个 FlatList（白屏/红屏）。
 * 这里：渲染失败时降级为纯文本展示，不影响其他消息。
 */
import React from "react";
import { Text, StyleSheet } from "react-native";
import { useTheme } from "../../src/theme";

interface Props {
  text: string;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

export class MarkdownErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidUpdate(prevProps: Props) {
    // 文本变化时重置失败状态（重试渲染）
    if (prevProps.text !== this.props.text && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      // 降级：纯文本
      return <FallbackText text={this.props.text} />;
    }
    return this.props.children;
  }
}

function FallbackText({ text }: { text: string }) {
  const { theme } = useTheme();
  return (
    <Text
      style={[styles.text, { color: theme.text }]}
      selectable
    >
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 15, lineHeight: 22 },
});
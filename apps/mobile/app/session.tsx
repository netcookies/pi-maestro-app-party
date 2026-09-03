import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useHost } from "../src/store";
import type { TimelineItem } from "@maestro-mobile/shared";
import { ExtensionUiDialog } from "../src/components/ExtensionUiDialog";

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, sendPrompt, sendAbort, answerDialog, cancelDialog } = useHost();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<TimelineItem>>(null);

  const timeline = state.timelines.get(id ?? "") ?? [];
  const session = state.sessions.get(id ?? "");
  const pendingDialog = state.dialogs[0];

  useEffect(() => {
    // 新消息时滚动到底部
    if (timeline.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [timeline.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !id) return;
    setInput("");
    setSending(true);
    try {
      await sendPrompt(id, text);
    } catch (e) {
      // 显示错误由 store.lastError 处理
    } finally {
      setSending(false);
    }
  };

  const renderItem = ({ item }: { item: TimelineItem }) => {
    const isUser = item.kind === "user";
    const isTool = item.kind === "tool";
    const isThinking = item.kind === "thinking";
    return (
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : isTool ? styles.bubbleTool : styles.bubbleAgent,
        ]}
      >
        {isThinking && <Text style={styles.thinkingLabel}>🧠 思考</Text>}
        {isTool && (
          <View style={styles.toolHeader}>
            <Text style={styles.toolLabel}>🔧 {item.toolName ?? "tool"}</Text>
            {item.isError ? <Text style={styles.toolError}>⚠ 失败</Text> : null}
          </View>
        )}
        <Text
          style={[
            isUser ? styles.textUser : styles.textAgent,
            isTool && styles.textTool,
          ]}
          selectable
        >
          {item.text}
        </Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{session?.title ?? "会话"}</Text>
        <Text style={styles.headerStatus}>
          {session?.runState === "streaming" ? "● 运行中" : session?.runState === "compacting" ? "● 压缩中" : "空闲"}
        </Text>
      </View>

      <FlatList
        ref={listRef}
        data={timeline}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {session?.runState === "streaming" && (
        <TouchableOpacity style={styles.abortButton} onPress={() => id && sendAbort(id)}>
          <Text style={styles.abortText}>■ 停止</Text>
        </TouchableOpacity>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={sending ? "发送中..." : "输入消息..."}
          placeholderTextColor="#484f58"
          multiline
          maxLength={2000}
        />
        <TouchableOpacity style={styles.sendButton} onPress={handleSend} disabled={sending || !input.trim()}>
          <Text style={styles.sendText}>发送</Text>
        </TouchableOpacity>
      </View>

      {pendingDialog && (
        <ExtensionUiDialog
          request={pendingDialog.request}
          onAnswer={(value) => answerDialog(pendingDialog.request.id, value)}
          onCancel={() => cancelDialog(pendingDialog.request.id)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0d1117" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 60 : 16,
    paddingBottom: 12,
    backgroundColor: "#161b22",
    borderBottomWidth: 1,
    borderBottomColor: "#21262d",
  },
  headerTitle: { fontSize: 17, fontWeight: "600", color: "#e6edf3", flex: 1 },
  headerStatus: { fontSize: 12, color: "#8b949e" },
  list: { flex: 1 },
  listContent: { padding: 16 },
  bubble: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    maxWidth: "90%",
  },
  bubbleUser: { backgroundColor: "#1f6feb", alignSelf: "flex-end" },
  bubbleAgent: { backgroundColor: "#161b22", alignSelf: "flex-start", borderWidth: 1, borderColor: "#21262d" },
  bubbleTool: {
    backgroundColor: "#0d1117",
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
  },
  toolHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  textTool: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 17,
    color: "#c9d1d9",
  },
  textUser: { color: "#fff", fontSize: 15, lineHeight: 21 },
  textAgent: { color: "#e6edf3", fontSize: 15, lineHeight: 21 },
  thinkingLabel: { color: "#d29922", fontSize: 11, marginBottom: 4, fontWeight: "600" },
  toolLabel: { color: "#58a6ff", fontSize: 11, marginBottom: 4, fontWeight: "600" },
  toolError: { color: "#f85149", fontSize: 12, marginTop: 4 },
  composer: {
    flexDirection: "row",
    padding: 12,
    backgroundColor: "#161b22",
    borderTopWidth: 1,
    borderTopColor: "#21262d",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: "#0d1117",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e6edf3",
    borderWidth: 1,
    borderColor: "#30363d",
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sendText: { color: "#fff", fontWeight: "600" },
  abortButton: {
    alignSelf: "center",
    backgroundColor: "#da3633",
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 6,
    marginBottom: 8,
  },
  abortText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
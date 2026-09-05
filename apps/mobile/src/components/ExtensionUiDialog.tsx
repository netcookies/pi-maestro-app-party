import React from "react";
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, ActivityIndicator,
} from "react-native";
import type { ExtensionUiRequest } from "@maestro-mobile/shared";
import { useTheme } from "../../src/theme";

interface Props {
  request: ExtensionUiRequest;
  onAnswer: (value: string | string[]) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

/** 仅对 #RRGGBB 追加 8 位透明度后缀，避免对非 6 位色值生成非法颜色串 */
function withAlpha(hex: string, alphaSuffix: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex + alphaSuffix : hex;
}

export function ExtensionUiDialog({ request, onAnswer, onCancel }: Props) {
  const { theme } = useTheme();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [freeText, setFreeText] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  // P2-7：editor 的 prefill 作为初始文本（仅 editor；input 保持空起点）
  React.useEffect(() => {
    if (request.method === "editor" && request.prefill) setFreeText(request.prefill);
  }, [request.method, request.prefill]);

  const hasOptions = Array.isArray(request.options) && request.options.length > 0;
  // host bridge（apps/host/src/mobile-ui-context.ts）约定 select 为单选：优先 value，兼容取 selected[0]
  const isSingleSelect = request.method === "select" && hasOptions;
  const isInput = request.method === "input";
  const isConfirm = request.method === "confirm";
  // P2-7：editor 复用多行输入框（prefill 作为初始值），否则只能取消，交互死路
  const isEditor = request.method === "editor";
  const showInput = isInput || isEditor;

  const confirmDisabled =
    submitting ||
    (showInput && freeText.trim().length === 0) ||
    // 保留原语义：选项分支未选中但输入了自定义答案时仍可确认
    (hasOptions && !isSingleSelect && selected.length === 0 && freeText.trim().length === 0);

  const runAnswer = (produce: () => void | Promise<void>) => {
    if (submitting) return;
    setSubmitting(true);
    // 弹窗通常在作答后被父级卸载；复位保证异常或复用场景下状态干净
    // 父级返回 Promise（WS bridge 异步送达）时保持 submitting 直到 settle，防重复提交（RV-003）
    Promise.resolve()
      .then(produce)
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  };

  const handleSelect = (option: string) => {
    if (submitting) return;
    if (isSingleSelect) {
      runAnswer(() => onAnswer([option]));
      return;
    }
    setSelected((prev) =>
      prev.includes(option) ? prev.filter((s) => s !== option) : [...prev, option],
    );
  };

  const handleConfirm = () => {
    if (submitting) return;
    if (isConfirm) {
      // P1-2：confirm 必须携带 confirmed 布尔语义（host 端只认 confirmed 字段，
      // 此前发 "yes" 导致用户点确认 host 收到的是拒绝）
      runAnswer(() => onAnswer("confirmed:true"));
    } else if (isInput || request.method === "editor") {
      const text = freeText.trim();
      if (!text) return;
      runAnswer(() => onAnswer(text));
    } else if (hasOptions && (selected.length > 0 || freeText.trim())) {
      runAnswer(() => onAnswer(selected.length > 0 ? selected : [freeText.trim()]));
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    runAnswer(onCancel);
  };

  return (
    <Modal transparent animationType="fade" visible>
      <View style={styles.overlay}>
        <View style={[styles.dialog, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>{request.title ?? "询问"}</Text>
          {request.message ? <Text style={[styles.message, { color: theme.muted }]}>{request.message}</Text> : null}

          <ScrollView style={styles.optionsList}>
            {request.options?.map((option) => {
              const isSelected = selected.includes(option);
              return (
                <TouchableOpacity
                  key={option}
                  style={[
                    styles.option,
                    { backgroundColor: theme.bg, borderColor: theme.border },
                    isSelected && { borderColor: theme.accent, backgroundColor: withAlpha(theme.accent, "22") },
                  ]}
                  onPress={() => handleSelect(option)}
                  accessibilityRole={isSingleSelect ? "radio" : "checkbox"}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={[styles.optionText, { color: theme.text }, isSelected && { color: theme.accent }]}>
                    {isSelected ? "✓ " : "  "}
                    {option}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {showInput || request.placeholder ? (
            <TextInput
              style={[styles.input, { backgroundColor: theme.bg, color: theme.text, borderColor: theme.border }]}
              value={freeText}
              onChangeText={setFreeText}
              placeholder={request.placeholder ?? "请输入…"}
              placeholderTextColor={theme.dim}
              autoFocus
              editable={!submitting}
              multiline={isEditor}
              numberOfLines={isEditor ? 6 : 1}
            />
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.cancelButton, { backgroundColor: theme.border }, submitting && styles.buttonDisabled]}
              onPress={handleCancel}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="取消"
              accessibilityState={{ disabled: submitting }}
            >
              <Text style={[styles.cancelText, { color: theme.muted }]}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmButton, { backgroundColor: theme.buttonPrimary }, confirmDisabled && styles.buttonDisabled]}
              onPress={handleConfirm}
              disabled={confirmDisabled}
              accessibilityRole="button"
              accessibilityLabel="确认"
              accessibilityState={{ disabled: confirmDisabled }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color={styles.confirmText.color} />
              ) : (
                <Text style={styles.confirmText}>确认</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: 24,
  },
  dialog: {
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    maxHeight: "80%",
  },
  title: { fontSize: 17, fontWeight: "600", marginBottom: 8 },
  message: { fontSize: 14, marginBottom: 12 },
  optionsList: { maxHeight: 250, marginBottom: 12 },
  option: {
    borderRadius: 8,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
  },
  optionText: { fontSize: 15 },
  input: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    borderWidth: 1,
  },
  buttonRow: { flexDirection: "row", gap: 10 },
  cancelButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  cancelText: { fontWeight: "600" },
  confirmButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmText: { color: "#fff", fontWeight: "600" },
  buttonDisabled: { opacity: 0.5 },
});

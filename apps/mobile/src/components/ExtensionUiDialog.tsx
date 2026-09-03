import React from "react";
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Platform,
} from "react-native";
import type { ExtensionUiRequest } from "@maestro-mobile/shared";
import { useTheme } from "../../src/theme";

interface Props {
  request: ExtensionUiRequest;
  onAnswer: (value: string | string[]) => void;
  onCancel: () => void;
}

export function ExtensionUiDialog({ request, onAnswer, onCancel }: Props) {
  const { theme } = useTheme();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [freeText, setFreeText] = React.useState("");

  const isMulti = request.method === "select" && request.options && request.options.length > 0
    ? true
    : false;
  const isSingle = request.method === "select" && request.options && request.options.length > 0
    ? true
    : false;
  const isInput = request.method === "input";
  const isConfirm = request.method === "confirm";

  const handleSelect = (label: string) => {
    if (selected.includes(label)) {
      setSelected(selected.filter((s) => s !== label));
    } else {
      setSelected([...selected, label]);
    }
  };

  const handleConfirm = () => {
    if (isInput) {
      onAnswer(freeText);
    } else if (isConfirm) {
      onAnswer("yes");
    } else if (request.options && request.options.length > 0) {
      if (selected.length === 0 && !freeText.trim()) {
        onCancel();
        return;
      }
      onAnswer(selected.length > 0 ? selected : [freeText.trim()]);
    }
  };

  return (
    <Modal transparent animationType="fade" visible>
      <View style={styles.overlay}>
        <View style={[styles.dialog, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>{request.title ?? "询问"}</Text>
          {request.message ? <Text style={[styles.message, { color: theme.muted }]}>{request.message}</Text> : null}

          <ScrollView style={styles.optionsList}>
            {request.options?.map((option) => (
              <TouchableOpacity
                key={option}
                style={[styles.option, { backgroundColor: theme.bg, borderColor: theme.border }, selected.includes(option) && { borderColor: theme.success, backgroundColor: theme.mdCodeBlockBg }]}
                onPress={() => handleSelect(option)}
              >
                <Text style={[styles.optionText, { color: theme.text }, selected.includes(option) && { color: theme.success }]}>
                  {selected.includes(option) ? "✓ " : "  "}
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {request.placeholder ? (
            <TextInput
              style={[styles.input, { backgroundColor: theme.bg, color: theme.text, borderColor: theme.border }]}
              value={freeText}
              onChangeText={setFreeText}
              placeholder={request.placeholder}
              placeholderTextColor={theme.dim}
              autoFocus
            />
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.cancelButton, { backgroundColor: theme.border }]} onPress={onCancel}>
              <Text style={[styles.cancelText, { color: theme.muted }]}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.confirmButton, { backgroundColor: theme.buttonPrimary }]} onPress={handleConfirm}>
              <Text style={styles.confirmText}>确认</Text>
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
});
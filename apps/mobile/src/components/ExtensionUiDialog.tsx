import React from "react";
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Platform,
} from "react-native";
import type { ExtensionUiRequest } from "@maestro-mobile/shared";

interface Props {
  request: ExtensionUiRequest;
  onAnswer: (value: string | string[]) => void;
  onCancel: () => void;
}

export function ExtensionUiDialog({ request, onAnswer, onCancel }: Props) {
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
        <View style={styles.dialog}>
          <Text style={styles.title}>{request.title ?? "询问"}</Text>
          {request.message ? <Text style={styles.message}>{request.message}</Text> : null}

          <ScrollView style={styles.optionsList}>
            {request.options?.map((option) => (
              <TouchableOpacity
                key={option}
                style={[styles.option, selected.includes(option) && styles.optionSelected]}
                onPress={() => handleSelect(option)}
              >
                <Text style={[styles.optionText, selected.includes(option) && styles.optionTextSelected]}>
                  {selected.includes(option) ? "✓ " : "  "}
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {request.placeholder ? (
            <TextInput
              style={styles.input}
              value={freeText}
              onChangeText={setFreeText}
              placeholder={request.placeholder}
              placeholderTextColor="#484f58"
              autoFocus
            />
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
              <Text style={styles.cancelText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmButton} onPress={handleConfirm}>
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
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: "#30363d",
    maxHeight: "80%",
  },
  title: { fontSize: 17, fontWeight: "600", color: "#e6edf3", marginBottom: 8 },
  message: { fontSize: 14, color: "#8b949e", marginBottom: 12 },
  optionsList: { maxHeight: 250, marginBottom: 12 },
  option: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "#21262d",
  },
  optionSelected: { borderColor: "#238636", backgroundColor: "#0d2816" },
  optionText: { color: "#e6edf3", fontSize: 15 },
  optionTextSelected: { color: "#3fb950" },
  input: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#e6edf3",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  buttonRow: { flexDirection: "row", gap: 10 },
  cancelButton: {
    flex: 1,
    backgroundColor: "#21262d",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  cancelText: { color: "#8b949e", fontWeight: "600" },
  confirmButton: {
    flex: 1,
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmText: { color: "#fff", fontWeight: "600" },
});
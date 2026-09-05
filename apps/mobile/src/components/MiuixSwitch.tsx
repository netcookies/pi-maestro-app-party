/**
 * MiuixSwitch — Miuix 药丸开关（设计稿 switchMarkup 对齐）
 * 44×26 轨道，20px knob，primary 底 + 白 knob；无动画依赖（RN 内置 layout 顺滑即可）
 */
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../theme";

interface Props {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function MiuixSwitch({ value, onValueChange, disabled, accessibilityLabel }: Props) {
  const { theme } = useTheme();
  const track = value ? theme.buttonPrimary : (theme.secondaryContainer ?? theme.border);
  const knobBg = value ? "#fff" : (theme.onSurfaceVariantSummary ?? theme.muted);
  return (
    <TouchableOpacity
      onPress={() => !disabled && onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      activeOpacity={0.8}
    >
      <View style={[styles.track, { backgroundColor: track, opacity: disabled ? 0.5 : 1 }]}>
        <View style={[styles.knob, { backgroundColor: knobBg, transform: [{ translateX: value ? 18 : 0 }] }]} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13, padding: 3, justifyContent: "center" },
  knob: { width: 20, height: 20, borderRadius: 10 },
});

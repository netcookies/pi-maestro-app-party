/**
 * MiuixSlider — Miuix 滑条（设计稿 sliderRow 对齐）
 * track + primary fill + 3 个 keyPoint 圆点 + thumb，PanResponder 拖动。
 * 离散步进（min..max 均分 step 段），释放时回调整数值。
 */
import React, { useRef, useCallback } from "react";
import { View, StyleSheet, PanResponder, LayoutChangeEvent, Text } from "react-native";
import { useTheme } from "../theme";

interface Props {
  label: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  onValueChange: (v: number) => void;
}

export function MiuixSlider({ label, min, max, value, unit = "", onValueChange }: Props) {
  const { theme } = useTheme();
  const widthRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;

  const clampStep = useCallback((raw: number) => {
    const ratio = Math.min(1, Math.max(0, raw));
    const v = Math.round(min + ratio * (max - min));
    return Math.min(max, Math.max(min, v));
  }, [min, max]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        onValueChange(clampStep(e.nativeEvent.locationX / Math.max(1, widthRef.current)));
      },
      onPanResponderMove: (e) => {
        onValueChange(clampStep(e.nativeEvent.locationX / Math.max(1, widthRef.current)));
      },
    }),
  ).current;

  const ratio = (value - min) / Math.max(1, max - min);
  const fmt = (v: number) => (unit ? `${v} ${unit}` : String(v));

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
        <Text style={[styles.val, { color: theme.accent }]}>{fmt(value)}</Text>
      </View>
      <View
        style={styles.hit}
        onLayout={(e: LayoutChangeEvent) => { widthRef.current = e.nativeEvent.layout.width; }}
        {...pan.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel={`${label}，当前 ${fmt(value)}`}
        accessibilityValue={{ min, max, now: value }}
      >
        <View style={[styles.track, { backgroundColor: theme.sliderBackground ?? theme.border }]}>
          <View style={[styles.fill, { backgroundColor: theme.accent, width: `${ratio * 100}%` }]} />
          {[0.25, 0.5, 0.75].map((p) => (
            <View key={p} style={[styles.keypoint, { left: `${p * 100}%`, backgroundColor: theme.sliderKeyPoint ?? theme.muted }]} />
          ))}
          <View
            style={[
              styles.thumb,
              { backgroundColor: theme.accent, left: `${ratio * 100}%`, shadowColor: theme.accent },
            ]}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: 10 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 },
  label: { fontSize: 14, fontWeight: "600" },
  val: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  hit: { paddingVertical: 8 },
  track: { height: 4, borderRadius: 2, justifyContent: "center" },
  fill: { height: 4, borderRadius: 2, position: "absolute", left: 0 },
  keypoint: { position: "absolute", width: 5, height: 5, borderRadius: 2.5, opacity: 0.7 },
  thumb: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    marginLeft: -11,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 2.5,
    borderColor: "#fff",
  },
});

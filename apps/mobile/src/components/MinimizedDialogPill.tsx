import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import { LineIcon } from "./LineIcon";

interface Props {
  /** 悬浮按钮上的短标签，例如「待裁决」「Plan」 */
  label: string;
  /** 可选计数徽标，例如剩余待处理数量 */
  badge?: number;
  /** 展开回弹窗 */
  onRestore: () => void;
  /** 无障碍描述，默认复用 label */
  accessibilityLabel?: string;
}

/**
 * 弹窗最小化后的边缘悬浮按钮。
 *
 * 目的：Plan / Ask 弹窗遮住会话正文时，用户需要先读内容才能裁决；
 * 最小化后弹窗收成右侧悬浮按钮，正文可滚动阅读，点按钮可随时还原。
 */
export function MinimizedDialogPill({ label, badge, onRestore, accessibilityLabel }: Props) {
  const { theme } = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.host}>
      <Pressable
        onPress={onRestore}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={({ pressed }) => [
          styles.pill,
          {
            backgroundColor: theme.buttonPrimary,
            borderColor: theme.accent,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <LineIcon name="expand" size={14} color="#FFFFFF" />
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {typeof badge === "number" && badge > 0 ? (
          <View style={[styles.badge, { backgroundColor: theme.error ?? "#E53E3E" }]}>
            <Text style={styles.badgeText}>{badge > 99 ? "99+" : String(badge)}</Text>
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    right: 0,
    top: "38%",
    zIndex: 900,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 10,
    paddingRight: 12,
    paddingVertical: 10,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    borderWidth: 1,
    borderRightWidth: 0,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
    maxWidth: 160,
  },
  label: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" },
});

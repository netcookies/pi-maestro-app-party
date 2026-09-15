import React, { useEffect, useRef } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useTheme, MIUIX_RADIUS } from "../theme";
import { hapticImpactLight } from "../utils/haptics";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

interface SpringBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  containerStyle?: ViewStyle;
  contentHeight?: number;
  keyboardVerticalOffset?: number;
  /** 可选多档吸附高度（从小到大排序，例如 [280, 480, 720]） */
  snapPoints?: number[];
  /** 初始档位索引（默认 0） */
  initialSnapIndex?: number;
  /** 档位发生变更时的回调 */
  onSnapChange?: (index: number) => void;
}

export function shouldDismissSheet(
  dy: number,
  vy: number,
  threshold = 80,
  velocityThreshold = 0.8,
): boolean {
  return dy > threshold || vy > velocityThreshold;
}

export function SpringBottomSheet({
  visible,
  onClose,
  children,
  containerStyle,
  contentHeight = 320,
  keyboardVerticalOffset = 0,
  snapPoints,
  initialSnapIndex = 0,
  onSnapChange,
}: SpringBottomSheetProps) {
  const { theme } = useTheme();
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  // 多档位高度计算
  const hasSnaps = Array.isArray(snapPoints) && snapPoints.length > 0;
  const maxHeight = hasSnaps ? snapPoints[snapPoints.length - 1] : contentHeight;
  // 档位对应的 translateY 偏移：最大档偏移为 0，低档位偏移为 (maxHeight - h)
  const snapOffsets = useRef<number[]>([]);
  snapOffsets.current = hasSnaps ? snapPoints.map((h) => Math.max(0, maxHeight - h)) : [0];

  const currentSnapIndex = useRef(initialSnapIndex);
  const baseOffset = useRef(hasSnaps ? snapOffsets.current[initialSnapIndex] ?? 0 : 0);

  useEffect(() => {
    if (visible) {
      void hapticImpactLight();
      const initIdx = Math.max(0, Math.min(initialSnapIndex, snapOffsets.current.length - 1));
      currentSnapIndex.current = initIdx;
      const targetOffset = hasSnaps ? snapOffsets.current[initIdx] : 0;
      baseOffset.current = targetOffset;

      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: targetOffset,
          friction: 8,
          tension: 80,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: SCREEN_HEIGHT,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, contentHeight, initialSnapIndex, hasSnaps, backdropOpacity, translateY]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // 当支持多档时，允许手势上下拖拽；单档只在向下滑动时拦截
        return hasSnaps ? Math.abs(gestureState.dy) > 3 : gestureState.dy > 5;
      },
      onPanResponderMove: (_, gestureState) => {
        if (!hasSnaps) {
          if (gestureState.dy > 0) translateY.setValue(gestureState.dy);
          return;
        }
        const raw = baseOffset.current + gestureState.dy;
        // 向上拖过最大档位时增加阻尼
        const damped = raw < 0 ? raw * 0.25 : raw;
        translateY.setValue(damped);
      },
      onPanResponderRelease: (_, gestureState) => {
        if (!hasSnaps) {
          // 单档原有逻辑：下滑超过 80 或甩动速度快时关闭
          if (shouldDismissSheet(gestureState.dy, gestureState.vy)) {
            void hapticImpactLight();
            Animated.parallel([
              Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
              Animated.timing(translateY, { toValue: SCREEN_HEIGHT, duration: 200, useNativeDriver: true }),
            ]).start(() => onClose());
          } else {
            Animated.spring(translateY, { toValue: 0, friction: 7, tension: 90, useNativeDriver: true }).start();
          }
          return;
        }

        // 多档位吸附计算
        const offsets = snapOffsets.current;
        const currentVal = baseOffset.current + gestureState.dy;
        const lowestOffset = offsets[0] ?? 0;

        // 向下拖动超过最低档 70 或在最低档快速下滑时关闭
        const isDismissGesture = (currentSnapIndex.current === 0 && gestureState.dy > 70)
          || (gestureState.vy > 0.8 && gestureState.dy > 30)
          || (currentVal > lowestOffset + 80);

        if (isDismissGesture) {
          void hapticImpactLight();
          Animated.parallel([
            Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
            Animated.timing(translateY, { toValue: SCREEN_HEIGHT, duration: 200, useNativeDriver: true }),
          ]).start(() => onClose());
          return;
        }

        // 速度冲量判定：快速向上或向下轻甩切换档位
        let targetIdx = currentSnapIndex.current;
        if (gestureState.vy < -0.4 && targetIdx < offsets.length - 1) {
          targetIdx += 1;
        } else if (gestureState.vy > 0.4 && targetIdx > 0) {
          targetIdx -= 1;
        } else {
          // 找最近距离的档位
          let minDiff = Infinity;
          offsets.forEach((off, idx) => {
            const diff = Math.abs(currentVal - off);
            if (diff < minDiff) {
              minDiff = diff;
              targetIdx = idx;
            }
          });
        }

        const finalOffset = offsets[targetIdx] ?? 0;
        const indexChanged = targetIdx !== currentSnapIndex.current;
        currentSnapIndex.current = targetIdx;
        baseOffset.current = finalOffset;

        if (indexChanged) {
          void hapticImpactLight();
          onSnapChange?.(targetIdx);
        }

        Animated.spring(translateY, {
          toValue: finalOffset,
          friction: 8,
          tension: 85,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  if (!visible) return null;

  return (
    <View style={[StyleSheet.absoluteFillObject, { zIndex: 999, elevation: 50 }]} pointerEvents="box-none">
      {/* 半透明遮罩层 */}
      <Animated.View
        style={[
          styles.backdrop,
          { opacity: backdropOpacity },
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      {/* 键盘避让容器：输入法弹出时抽屉自动向上托起，不被输入法遮挡 */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardVerticalOffset}
        style={styles.keyboardWrap}
        pointerEvents="box-none"
      >
        {/* 底部物理弹簧抽屉 */}
        <Animated.View
          style={[
            styles.sheetContainer,
            {
              backgroundColor: theme.cardBg,
              borderColor: theme.border,
              transform: [{ translateY }],
            },
            containerStyle,
          ]}
        >
          {/* 顶部手柄条与拖动手势捕获区 */}
          <View {...panResponder.panHandlers} style={styles.handleArea}>
            <View style={[styles.handleBar, { backgroundColor: theme.dim }]} />
          </View>

          {/* 抽屉内容 */}
          <View style={styles.content}>{children}</View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  keyboardWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
  },
  sheetContainer: {
    width: "100%",
    borderTopLeftRadius: MIUIX_RADIUS.lg,
    borderTopRightRadius: MIUIX_RADIUS.lg,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 20,
    paddingBottom: 28,
  },
  handleArea: {
    width: "100%",
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  handleBar: {
    width: 40,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.6,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
});

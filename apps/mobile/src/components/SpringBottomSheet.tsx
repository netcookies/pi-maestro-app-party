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
}: SpringBottomSheetProps) {
  const { theme } = useTheme();
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      void hapticImpactLight();
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: 0,
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
          toValue: contentHeight + 100,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, contentHeight, backdropOpacity, translateY]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // 只有向下滑动才捕获，允许内部水平操作
        return gestureState.dy > 5;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        // 下滑超过 80 或甩动速度快时关闭
        if (shouldDismissSheet(gestureState.dy, gestureState.vy)) {
          void hapticImpactLight();
          Animated.parallel([
            Animated.timing(backdropOpacity, {
              toValue: 0,
              duration: 180,
              useNativeDriver: true,
            }),
            Animated.timing(translateY, {
              toValue: contentHeight + 100,
              duration: 200,
              useNativeDriver: true,
            }),
          ]).start(() => onClose());
        } else {
          // 回弹
          Animated.spring(translateY, {
            toValue: 0,
            friction: 7,
            tension: 90,
            useNativeDriver: true,
          }).start();
        }
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
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.5,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
});

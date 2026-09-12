import { useRef } from "react";
import {
  Animated,
  PanResponder,
  Dimensions,
  type GestureResponderHandlers,
  type ViewStyle,
} from "react-native";
import { useRouter } from "expo-router";
import { hapticImpactLight } from "../utils/haptics";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

interface TabSwipeConfig {
  leftRoute?: string;
  rightRoute?: string;
  enabled?: boolean;
}

export function shouldTriggerTabSwipe(
  dx: number,
  dy: number,
  vx: number,
  threshold = 60,
  ratio = 2,
): "left" | "right" | null {
  // 水平位移必须明显大于垂直位移，防止干扰垂直滚动
  if (Math.abs(dx) < threshold && Math.abs(vx) < 0.6) return null;
  if (Math.abs(dx) < Math.abs(dy) * ratio) return null;

  // 手指向左划（dx < 0）-> 切换到右边的下一个 Tab
  if (dx < 0 || vx < -0.6) return "right";
  // 手指向右划（dx > 0）-> 切换到左边的上一个 Tab
  if (dx > 0 || vx > 0.6) return "left";

  return null;
}

export interface UseTabSwipeResult {
  panHandlers: GestureResponderHandlers;
  animatedStyle: Animated.WithAnimatedValue<ViewStyle>;
  swipeAnim: Animated.Value;
}

export function useTabSwipe({
  leftRoute,
  rightRoute,
  enabled = true,
}: TabSwipeConfig): UseTabSwipeResult {
  const router = useRouter();
  const swipeAnim = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        if (!enabled) return false;
        // 只有水平距离大于 15 且水平明显大于垂直时才捕获
        const { dx, dy } = gestureState;
        return Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy) * 2;
      },
      onPanResponderMove: (_, gestureState) => {
        if (!enabled) return;
        // 限制拖拽边界：如果左/右侧已没有路由，增加强阻尼
        let dx = gestureState.dx;
        if (dx > 0 && !leftRoute) {
          dx = dx * 0.2;
        } else if (dx < 0 && !rightRoute) {
          dx = dx * 0.2;
        }
        swipeAnim.setValue(dx);
      },
      onPanResponderRelease: (_, gestureState) => {
        if (!enabled) return;
        const action = shouldTriggerTabSwipe(gestureState.dx, gestureState.dy, gestureState.vx);

        if (action === "left" && leftRoute) {
          void hapticImpactLight();
          // 旧页面伴随滑动向右滑出并下沉
          Animated.parallel([
            Animated.timing(swipeAnim, {
              toValue: SCREEN_WIDTH * 0.6,
              duration: 160,
              useNativeDriver: true,
            }),
          ]).start(() => {
            swipeAnim.setValue(0);
            router.replace(leftRoute as any);
          });
        } else if (action === "right" && rightRoute) {
          void hapticImpactLight();
          // 旧页面伴随滑动向左滑出并下沉
          Animated.parallel([
            Animated.timing(swipeAnim, {
              toValue: -SCREEN_WIDTH * 0.6,
              duration: 160,
              useNativeDriver: true,
            }),
          ]).start(() => {
            swipeAnim.setValue(0);
            router.replace(rightRoute as any);
          });
        } else {
          // 未达切换阈值，物理弹簧平滑回弹复位
          Animated.spring(swipeAnim, {
            toValue: 0,
            friction: 7,
            tension: 90,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  // 驱动页面下沉微缩放与平移跟随
  const animatedStyle: Animated.WithAnimatedValue<ViewStyle> = {
    transform: [
      { translateX: swipeAnim },
      {
        scale: swipeAnim.interpolate({
          inputRange: [-SCREEN_WIDTH, 0, SCREEN_WIDTH],
          outputRange: [0.95, 1, 0.95],
          extrapolate: "clamp",
        }),
      },
    ],
    opacity: swipeAnim.interpolate({
      inputRange: [-SCREEN_WIDTH, 0, SCREEN_WIDTH],
      outputRange: [0.88, 1, 0.88],
      extrapolate: "clamp",
    }),
  };

  return {
    panHandlers: panResponder.panHandlers,
    animatedStyle,
    swipeAnim,
  };
}

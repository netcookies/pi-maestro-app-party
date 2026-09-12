import React, { useRef } from "react";
import {
  Animated,
  Pressable,
  type StyleProp,
  type ViewStyle,
  type GestureResponderEvent,
} from "react-native";
import { hapticImpactLight } from "../utils/haptics";

interface SpringCardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: (event: GestureResponderEvent) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  disabled?: boolean;
  accessibilityRole?: "button" | "none";
  accessibilityLabel?: string;
  accessibilityState?: { disabled?: boolean; selected?: boolean };
  scaleTarget?: number;
}

export function SpringCard({
  children,
  style,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityRole = "button",
  accessibilityLabel,
  accessibilityState,
  scaleTarget = 0.975,
}: SpringCardProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    if (disabled) return;
    void hapticImpactLight();
    Animated.spring(scale, {
      toValue: scaleTarget,
      friction: 8,
      tension: 100,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    if (disabled) return;
    Animated.spring(scale, {
      toValue: 1,
      friction: 6,
      tension: 80,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

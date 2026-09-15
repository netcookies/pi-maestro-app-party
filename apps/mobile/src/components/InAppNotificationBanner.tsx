import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTheme, hexToRgba } from "../theme";
import { onInAppBanner, type InAppBannerPayload } from "../notifications";

export function InAppNotificationBanner() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [banner, setBanner] = useState<InAppBannerPayload | null>(null);

  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  const dismiss = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    Animated.parallel([
      Animated.timing(translateY, { toValue: -120, duration: 250, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setBanner(null));
  };

  useEffect(() => {
    return onInAppBanner((payload) => {
      if (!payload) {
        dismiss();
        return;
      }
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setBanner(payload);

      // 下滑展示动画
      translateY.setValue(-100);
      opacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, friction: 8, tension: 50, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();

      // 4.5 秒后自动收起
      hideTimer.current = setTimeout(() => {
        dismiss();
      }, 4500);
    });
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy < -6,
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy < -10) {
          dismiss();
        }
      },
    }),
  ).current;

  if (!banner) return null;

  const isAsk = banner.type === "ask";

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.wrapper,
        {
          top: insets.top + 6,
          transform: [{ translateY }],
          opacity,
        },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        activeOpacity={0.92}
        style={[
          styles.container,
          {
            backgroundColor: theme.cardBg ?? "#FFFFFF",
            borderColor: isAsk ? theme.accent : theme.success,
            shadowColor: "#000",
          },
        ]}
        onPress={() => {
          dismiss();
          router.push({ pathname: "/session", params: { id: banner.sessionId } });
        }}
      >
        <View style={styles.content}>
          <View style={styles.headerRow}>
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: isAsk ? hexToRgba(theme.accent, 0.16) : hexToRgba(theme.success, 0.16),
                },
              ]}
            >
              <Text style={[styles.badgeText, { color: isAsk ? theme.accent : theme.success }]}>
                {isAsk ? "待确认" : "完成"}
              </Text>
            </View>
            <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
              {banner.title}
            </Text>
          </View>
          <Text style={[styles.body, { color: theme.muted }]} numberOfLines={2}>
            {banner.body}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 9999,
  },
  container: {
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1.5,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 8,
  },
  content: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginRight: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },
  body: {
    fontSize: 13,
    lineHeight: 18,
  },
});

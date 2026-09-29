import React, { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useI18n } from "../../i18n";
import type { AppTheme } from "../../theme";
import { LineIcon } from "../LineIcon";

export interface MarkdownExpandRequest {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

interface MarkdownExpandViewerProps {
  visible: boolean;
  title: string;
  theme: AppTheme;
  children: React.ReactNode | ((rotated: boolean) => React.ReactNode);
  onClose: () => void;
  actions?: React.ReactNode;
}

export function MarkdownExpandViewer(props: MarkdownExpandViewerProps) {
  if (!props.visible) return null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
      onDismiss={props.onClose}
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <MarkdownExpandSurface {...props} />
      </SafeAreaProvider>
    </Modal>
  );
}

function MarkdownExpandSurface({
  title,
  theme,
  children,
  onClose,
  actions,
}: MarkdownExpandViewerProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [rotated, setRotated] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const rotateLabel = rotated ? t.restoreContent : t.rotateContent;

  const handleViewportLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((current) => current.width === width && current.height === height ? current : { width, height });
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.root, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {title}
        </Text>
        <View style={styles.headerActions}>
          {actions}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.closeExpandedContent}
            hitSlop={8}
            onPress={onClose}
            style={styles.closeButton}
          >
            <LineIcon name="x" size={20} color={theme.muted} />
          </Pressable>
        </View>
      </View>
      <View style={styles.viewerBody} onLayout={handleViewportLayout}>
        {viewport.width > 0 && viewport.height > 0 ? (
          <View
            key={rotated ? "landscape-content" : "portrait-content"}
            style={[
              styles.orientedViewport,
              rotated
                ? {
                    width: viewport.height,
                    height: viewport.width,
                    left: (viewport.width - viewport.height) / 2,
                    top: (viewport.height - viewport.width) / 2,
                    transform: [{ rotate: "90deg" }],
                  }
                : {
                    width: viewport.width,
                    height: viewport.height,
                    left: 0,
                    top: 0,
                  },
            ]}
          >
            <ScrollView
              style={styles.verticalScroll}
              contentContainerStyle={styles.verticalContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              {typeof children === "function" ? children(rotated) : children}
            </ScrollView>
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={rotateLabel}
        accessibilityState={{ checked: rotated }}
        onPress={() => setRotated((value) => !value)}
        style={({ pressed }) => [
          styles.rotateFab,
          {
            right: Math.max(16, insets.right + 12),
            bottom: Math.max(16, insets.bottom + 12),
            backgroundColor: theme.accent,
            borderColor: theme.border,
          },
          pressed && styles.pressed,
        ]}
      >
        <LineIcon name="rotate" size={21} color="#FFFFFF" strokeWidth={2} />
      </Pressable>
    </SafeAreaView>
  );
}

export function MarkdownExpandButton({
  theme,
  onPress,
}: {
  theme: AppTheme;
  onPress: () => void;
}) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.expand}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.expandButton, pressed && styles.pressed]}
    >
      <LineIcon name="expand" size={13} color={theme.muted} />
      <Text style={[styles.expandLabel, { color: theme.muted }]}>{t.expand}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 18,
    paddingRight: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  viewerBody: {
    flex: 1,
    overflow: "hidden",
  },
  orientedViewport: {
    position: "absolute",
  },
  verticalScroll: { flex: 1 },
  verticalContent: { flexGrow: 1, padding: 16 },
  rotateFab: {
    position: "absolute",
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  expandButton: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  expandLabel: { fontSize: 11, fontWeight: "500" },
  pressed: { opacity: 0.55 },
});

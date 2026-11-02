import React, { useState } from "react";
import { Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { TimelineItem } from "@maestro-mobile/shared";
import { CollapsibleTool } from "./CollapsibleTool";
import { InlineImage } from "./InlineImage";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../theme";
import { useI18n, type I18nDictionary } from "../i18n";
import { toolInvocationCount } from "../timeline-rows";
import { collectImagePaths } from "../tool-images";

const PREVIEW_ITEMS = 5;

function statusLabel(status: "running" | "failed" | "completed" | "pending", t: I18nDictionary): string {
  switch (status) {
    case "running": return t.statusRunning;
    case "failed": return t.statusFailed;
    case "completed": return t.statusCompleted;
    default: return t.statusPending;
  }
}

function ToolDetails({ items }: { items: TimelineItem[] }) {
  return (
    <>
      {items.map((item) => {
        const imagePaths = collectImagePaths(item);
        return (
          <View key={item.id} style={{ marginTop: MIUIX_SPACE.xs }}>
            <CollapsibleTool toolName={item.toolName ?? "tool"} text={item.text} isError={item.isError || item.error !== undefined} />
            {imagePaths.length > 0 ? (
              <View style={{ marginTop: MIUIX_SPACE.xs }}>
                {imagePaths.map((path, index) => (
                  <InlineImage key={`${item.id}:image:${index}`} path={path} />
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

export function ToolCallGroup({
  items,
  status,
  invocationCount,
}: {
  items: TimelineItem[];
  status: "running" | "failed" | "completed" | "pending";
  invocationCount: number;
}) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const invocationTotal = invocationCount || toolInvocationCount(items);
  const visible = items.slice(0, PREVIEW_ITEMS);
  const failed = status === "failed";

  return (
    <View style={{ width: "100%", borderWidth: 1, borderColor: failed ? theme.error : theme.border, borderRadius: MIUIX_RADIUS.md, backgroundColor: theme.cardBg, padding: MIUIX_SPACE.sm }}>
      <TouchableOpacity
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${t.toolCalls(invocationTotal)}，${statusLabel(status, t)}${failed ? t.hasFailedCalls : ""}`}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: MIUIX_SPACE.sm, padding: MIUIX_SPACE.xs }}
      >
        <Text style={{ flex: 1, color: failed ? theme.error : theme.text, fontSize: MIUIX_TYPE.body2, fontWeight: "700" }} numberOfLines={1}>
          {t.toolCalls(invocationTotal)}
        </Text>
        <Text style={{ color: failed ? theme.error : status === "running" ? theme.accent : theme.muted, fontSize: MIUIX_TYPE.footnote1 }}>
          {statusLabel(status, t)} · {expanded ? t.collapse : t.expand}
        </Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={{ marginTop: MIUIX_SPACE.xs }}>
          <ToolDetails items={visible} />
          {items.length > visible.length ? (
            <TouchableOpacity onPress={() => setDetailsOpen(true)} accessibilityRole="button" accessibilityLabel={t.viewAllCalls(items.length)} style={{ padding: MIUIX_SPACE.sm }}>
              <Text style={{ color: theme.accent, fontSize: MIUIX_TYPE.footnote1 }}>{t.viewAllCalls(items.length)}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <Modal visible={detailsOpen} animationType="slide" onRequestClose={() => setDetailsOpen(false)}>
        <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 48 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: MIUIX_SPACE.lg, paddingVertical: MIUIX_SPACE.md, borderBottomWidth: 1, borderBottomColor: theme.border }}>
            <Text style={{ color: theme.text, fontSize: MIUIX_TYPE.title4, fontWeight: "700" }}>{t.toolCalls(items.length)}</Text>
            <TouchableOpacity onPress={() => setDetailsOpen(false)} accessibilityRole="button" accessibilityLabel={t.closeToolDetails}>
              <Text style={{ color: theme.accent, fontSize: MIUIX_TYPE.body2 }}>{t.close}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: MIUIX_SPACE.md, paddingBottom: MIUIX_SPACE.xxl }}>
            <ToolDetails items={items} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

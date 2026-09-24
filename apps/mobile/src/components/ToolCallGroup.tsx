import React, { useState } from "react";
import { Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { TimelineItem } from "@maestro-mobile/shared";
import { CollapsibleTool } from "./CollapsibleTool";
import { InlineImage } from "./InlineImage";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../theme";
import { toolInvocationCount } from "../timeline-rows";

const PREVIEW_ITEMS = 5;

function statusLabel(status: "running" | "failed" | "completed" | "pending"): string {
  switch (status) {
    case "running": return "运行中";
    case "failed": return "失败";
    case "completed": return "已完成";
    default: return "处理中";
  }
}

function ToolDetails({ items }: { items: TimelineItem[] }) {
  return (
    <>
      {items.map((item) => (
        <View key={item.id} style={{ marginTop: MIUIX_SPACE.xs }}>
          <CollapsibleTool toolName={item.toolName ?? "tool"} text={item.text} isError={item.isError || item.error !== undefined} />
          {(item.images?.length ?? 0) > 0 ? item.images?.map((path, index) => <InlineImage key={`${item.id}:image:${index}`} path={path} />) : null}
        </View>
      ))}
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
        accessibilityLabel={`工具调用 ${invocationTotal} 次，${statusLabel(status)}${failed ? "，有失败调用" : ""}`}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: MIUIX_SPACE.sm, padding: MIUIX_SPACE.xs }}
      >
        <Text style={{ flex: 1, color: failed ? theme.error : theme.text, fontSize: MIUIX_TYPE.body2, fontWeight: "700" }} numberOfLines={1}>
          工具调用 {invocationTotal} 次
        </Text>
        <Text style={{ color: failed ? theme.error : status === "running" ? theme.accent : theme.muted, fontSize: MIUIX_TYPE.footnote1 }}>
          {statusLabel(status)} · {expanded ? "收起" : "展开"}
        </Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={{ marginTop: MIUIX_SPACE.xs }}>
          <ToolDetails items={visible} />
          {items.length > visible.length ? (
            <TouchableOpacity onPress={() => setDetailsOpen(true)} accessibilityRole="button" accessibilityLabel={`查看全部 ${items.length} 次工具调用`} style={{ padding: MIUIX_SPACE.sm }}>
              <Text style={{ color: theme.accent, fontSize: MIUIX_TYPE.footnote1 }}>查看全部 {items.length} 次调用</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <Modal visible={detailsOpen} animationType="slide" onRequestClose={() => setDetailsOpen(false)}>
        <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: 48 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: MIUIX_SPACE.lg, paddingVertical: MIUIX_SPACE.md, borderBottomWidth: 1, borderBottomColor: theme.border }}>
            <Text style={{ color: theme.text, fontSize: MIUIX_TYPE.title4, fontWeight: "700" }}>工具调用 {items.length} 次</Text>
            <TouchableOpacity onPress={() => setDetailsOpen(false)} accessibilityRole="button" accessibilityLabel="关闭工具详情">
              <Text style={{ color: theme.accent, fontSize: MIUIX_TYPE.body2 }}>关闭</Text>
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

import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { HostError } from "@maestro-mobile/shared";
import { useTheme, MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE } from "../theme";
import { sessionErrorPresentation } from "../session-error";

export function SessionErrorBlock({ error, fallbackText }: { error?: HostError; fallbackText: string }) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const detail = sessionErrorPresentation(error, fallbackText);
  const copyText = detail.sourceText ?? fallbackText;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`${detail.title}${detail.provider ? ` · ${detail.provider}` : ""}${detail.httpStatus ? ` · HTTP ${detail.httpStatus}` : ""} · ${detail.message}`}
      style={{
        width: "100%",
        borderWidth: 1,
        borderColor: theme.error,
        borderRadius: MIUIX_RADIUS.md,
        backgroundColor: theme.cardBg,
        padding: MIUIX_SPACE.md,
      }}
    >
      <Text style={{ color: theme.error, fontSize: MIUIX_TYPE.body2, fontWeight: "700" }}>
        {detail.title}{detail.provider ? ` · ${detail.provider}` : ""}{detail.httpStatus !== undefined ? ` · HTTP ${detail.httpStatus}` : ""}
      </Text>
      <Text selectable style={{ color: theme.text, fontSize: MIUIX_TYPE.body2, marginTop: 5 }}>
        {detail.message}
      </Text>
      {detail.type ? <Text selectable style={{ color: theme.muted, fontSize: MIUIX_TYPE.footnote2, marginTop: 4 }}>type: {detail.type}</Text> : null}
      {detail.code ? <Text selectable style={{ color: theme.muted, fontSize: MIUIX_TYPE.footnote2, marginTop: 2 }}>code: {detail.code}</Text> : null}
      {expanded && detail.sourceText ? (
        <Text selectable style={{ color: theme.muted, fontSize: MIUIX_TYPE.footnote2, lineHeight: 17, marginTop: 7 }}>
          {detail.sourceText}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: MIUIX_SPACE.md, marginTop: MIUIX_SPACE.sm }}>
        {detail.sourceText ? (
          <TouchableOpacity
            onPress={() => setExpanded((value) => !value)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={expanded ? "收起错误详情" : "展开错误详情"}
          >
            <Text style={{ color: theme.accent, fontSize: MIUIX_TYPE.footnote2 }}>{expanded ? "收起详情" : "查看原始错误"}</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={() => void Clipboard.setStringAsync(copyText)}
          accessibilityRole="button"
          accessibilityLabel="复制错误信息"
        >
          <Text style={{ color: theme.accent, fontSize: MIUIX_TYPE.footnote2 }}>复制</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

import { Platform, StyleSheet } from "react-native";
import type { AppTheme } from "../../theme";
import { HEADING_AMBER } from "./color-utils";

export function createChatMarkdownStyles(theme: AppTheme) {
  const isDark = theme.name.includes("dark");
  const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

  return StyleSheet.create({
    body: {
      color: theme.text,
      fontSize: 15,
      lineHeight: 22,
      minWidth: 0,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 8,
      flexWrap: "wrap",
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "flex-start",
      width: "100%",
      minWidth: 0,
    },
    text: {
      color: theme.text,
      fontSize: 15,
      lineHeight: 22,
    },
    heading1: {
      color: HEADING_AMBER,
      fontSize: 20,
      lineHeight: 26,
      fontWeight: "700",
      marginTop: 12,
      marginBottom: 6,
    },
    heading2: {
      color: HEADING_AMBER,
      fontSize: 18,
      lineHeight: 24,
      fontWeight: "700",
      marginTop: 10,
      marginBottom: 5,
    },
    heading3: {
      color: HEADING_AMBER,
      fontSize: 16,
      lineHeight: 22,
      fontWeight: "700",
      marginTop: 8,
      marginBottom: 4,
    },
    heading4: {
      color: HEADING_AMBER,
      fontSize: 15,
      lineHeight: 20,
      fontWeight: "700",
      marginTop: 6,
      marginBottom: 3,
    },
    heading5: {
      color: HEADING_AMBER,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: "700",
      marginTop: 4,
      marginBottom: 2,
    },
    heading6: {
      color: HEADING_AMBER,
      fontSize: 13,
      lineHeight: 16,
      fontWeight: "700",
      marginTop: 4,
      marginBottom: 2,
    },
    strong: {
      fontWeight: "700",
      color: theme.text,
    },
    em: {
      fontStyle: "italic",
    },
    s: {
      textDecorationLine: "line-through",
      color: theme.muted,
    },
    code_inline: {
      backgroundColor: "transparent",
      borderWidth: 0,
      borderColor: "transparent",
      padding: 0,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: 0,
      fontFamily: monoFont,
      fontSize: 13.5,
      fontWeight: "600",
      color: theme.accent,
    },
    code_block: {
      fontFamily: monoFont,
      fontSize: 13,
      lineHeight: 18,
      color: theme.mdCodeBlock ?? theme.text,
    },
    fence: {
      backgroundColor: theme.mdCodeBlockBg ?? (isDark ? "#161B22" : "#F6F8FA"),
      borderColor: theme.border,
      borderWidth: 1,
      borderRadius: 8,
      marginVertical: 8,
      overflow: "hidden",
      width: "100%",
    },
    fence_header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    fence_language_label: {
      fontFamily: monoFont,
      fontSize: 11,
      fontWeight: "600",
      color: theme.muted,
      textTransform: "uppercase",
    },
    fence_code: {
      padding: 10,
    },
    bullet_list: {
      marginVertical: 4,
      minWidth: 0,
    },
    ordered_list: {
      marginVertical: 4,
      minWidth: 0,
    },
    list_item: {
      flexDirection: "row",
      alignItems: "flex-start",
      marginVertical: 2,
      minWidth: 0,
    },
    bullet_list_icon: {
      color: theme.accent,
      fontSize: 14,
      marginRight: 6,
      lineHeight: 22,
    },
    bullet_list_content: {
      flex: 1,
      minWidth: 0,
    },
    ordered_list_icon: {
      color: theme.accent,
      fontSize: 13,
      marginRight: 6,
      lineHeight: 22,
      fontWeight: "600",
    },
    ordered_list_content: {
      flex: 1,
      minWidth: 0,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.mdQuoteBorder ?? theme.accent,
      paddingLeft: 10,
      marginVertical: 6,
      opacity: 0.9,
      backgroundColor: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
      borderRadius: 2,
    },
    hr: {
      backgroundColor: theme.mdHr ?? theme.border,
      height: 1,
      marginVertical: 10,
    },
    link: {
      color: theme.mdLink ?? theme.accent,
      textDecorationLine: "underline",
    },
    table: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      marginVertical: 8,
      overflow: "hidden",
      minWidth: 0,
    },
    thead: {
      backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    tbody: {
      minWidth: 0,
    },
    tr: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    th: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      fontWeight: "700",
      color: theme.text,
      fontSize: 13,
      flex: 1,
    },
    td: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      color: theme.text,
      fontSize: 13,
      flex: 1,
    },
  });
}

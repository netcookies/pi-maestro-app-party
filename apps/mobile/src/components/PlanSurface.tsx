import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { DesktopPlanRequest, DesktopPlanResponse, SessionTargetIdentity } from "@maestro-mobile/shared";
import { useTheme } from "../theme";

interface Props {
  request: DesktopPlanRequest;
  target: SessionTargetIdentity;
  initialDraft?: string;
  onResponse: (response: DesktopPlanResponse, target: SessionTargetIdentity) => void;
  onCancel: (request: DesktopPlanRequest, target: SessionTargetIdentity) => void;
}

function actionLabel(action: string): string {
  switch (action) {
    case "execute": return "执行计划";
    case "modify": return "编辑计划";
    case "discuss": return "继续讨论";
    case "accept": return "接受";
    case "reject": return "拒绝";
    default: return action;
  }
}

export function PlanSurface({ request, target, initialDraft, onResponse, onCancel }: Props) {
  const { theme } = useTheme();
  const [draft, setDraft] = useState(initialDraft ?? request.markdown);
  const [discussion, setDiscussion] = useState("");
  const [editing, setEditing] = useState(request.kind === "review");
  const [discussing, setDiscussing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  React.useEffect(() => {
    setDraft(initialDraft ?? request.markdown);
  }, [request.requestId, request.revision, initialDraft, request.markdown]);

  const actions = useMemo(() => {
    const available = request.availableActions.length > 0 ? request.availableActions : ["execute"];
    return [...new Set(available)];
  }, [request.availableActions]);

  const submit = (response: DesktopPlanResponse): void => {
    if (submitting) return;
    setSubmitting(true);
    onResponse(response, target);
  };

  const submitEdit = (): void => {
    if (draft.trim().length === 0) return;
    submit({
      type: "desktop_plan_response",
      requestId: request.requestId,
      kind: request.kind,
      status: "edited",
      markdown: draft,
      expectedRevision: request.revision,
    });
  };

  const submitDiscussion = (): void => {
    if (discussion.trim().length === 0) return;
    submit({
      type: "desktop_plan_response",
      requestId: request.requestId,
      kind: request.kind,
      status: "decision",
      decision: { action: "discuss", discussion: discussion.trim() },
    });
  };

  const submitDecision = (action: string): void => {
    submit({
      type: "desktop_plan_response",
      requestId: request.requestId,
      kind: request.kind,
      status: "decision",
      decision: {
        action,
        ...(action === "execute" && request.defaultExecution ? { execution: request.defaultExecution } : {}),
      },
    });
  };

  return (
    <Modal transparent animationType="fade" visible>
      <View style={styles.overlay}>
        <View style={[styles.surface, { backgroundColor: theme.cardBg ?? theme.bg, borderColor: theme.border }]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.text }]}>{request.kind === "review" ? "审阅计划" : "确认计划"}</Text>
              <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>{request.pathLabel} · revision {request.revision}</Text>
            </View>
            <TouchableOpacity
              onPress={() => onCancel(request, target)}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="取消计划"
              style={styles.closeButton}
            >
              <Text style={[styles.close, { color: theme.muted }]}>×</Text>
            </TouchableOpacity>
          </View>

          {!editing && !discussing ? (
            <ScrollView style={[styles.preview, { borderColor: theme.border }]} contentContainerStyle={styles.previewContent}>
              <Text selectable style={[styles.markdown, { color: theme.text }]}>{request.markdown}</Text>
            </ScrollView>
          ) : null}

          {editing ? (
            <TextInput
              multiline
              value={draft}
              onChangeText={setDraft}
              editable={!submitting}
              textAlignVertical="top"
              style={[styles.editor, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
              accessibilityLabel="计划编辑器"
            />
          ) : null}

          {discussing ? (
            <TextInput
              multiline
              value={discussion}
              onChangeText={setDiscussion}
              editable={!submitting}
              placeholder="输入要继续讨论的内容"
              placeholderTextColor={theme.muted}
              textAlignVertical="top"
              style={[styles.editor, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
              accessibilityLabel="计划讨论内容"
            />
          ) : null}

          <View style={styles.actions}>
            {editing ? (
              <TouchableOpacity
                onPress={submitEdit}
                disabled={submitting || draft.trim().length === 0}
                style={[styles.primary, { backgroundColor: theme.accent, opacity: submitting || draft.trim().length === 0 ? 0.45 : 1 }]}
                accessibilityRole="button"
              >
                {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>保存编辑</Text>}
              </TouchableOpacity>
            ) : discussing ? (
              <TouchableOpacity
                onPress={submitDiscussion}
                disabled={submitting || discussion.trim().length === 0}
                style={[styles.primary, { backgroundColor: theme.accent, opacity: submitting || discussion.trim().length === 0 ? 0.45 : 1 }]}
                accessibilityRole="button"
              >
                <Text style={styles.primaryText}>发送讨论</Text>
              </TouchableOpacity>
            ) : (
              actions.map((action) => (
                <TouchableOpacity
                  key={action}
                  onPress={() => action === "modify" ? setEditing(true) : action === "discuss" ? setDiscussing(true) : submitDecision(action)}
                  disabled={submitting}
                  style={[styles.action, { borderColor: theme.border, backgroundColor: theme.inputBg, opacity: submitting ? 0.5 : 1 }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.actionText, { color: theme.text }]}>{actionLabel(action)}</Text>
                </TouchableOpacity>
              ))
            )}
            {(editing || discussing) ? (
              <TouchableOpacity onPress={() => { setEditing(false); setDiscussing(false); }} disabled={submitting} style={styles.backButton}>
                <Text style={[styles.backText, { color: theme.muted }]}>返回预览</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: "rgba(0,0,0,0.45)" },
  surface: { maxHeight: "88%", borderWidth: 1, borderRadius: 8, padding: 18, gap: 14 },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  headerText: { flex: 1, gap: 4 },
  title: { fontSize: 19, fontWeight: "700" },
  meta: { fontSize: 12 },
  closeButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  close: { fontSize: 26, lineHeight: 28 },
  preview: { maxHeight: 360, borderWidth: 1, borderRadius: 6 },
  previewContent: { padding: 12 },
  markdown: { fontSize: 14, lineHeight: 21 },
  editor: { minHeight: 240, maxHeight: 400, borderWidth: 1, borderRadius: 6, padding: 12, fontSize: 14, lineHeight: 21 },
  actions: { gap: 8 },
  action: { minHeight: 44, borderWidth: 1, borderRadius: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  actionText: { fontSize: 14, fontWeight: "600" },
  primary: { minHeight: 44, borderRadius: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  backButton: { minHeight: 36, alignItems: "center", justifyContent: "center" },
  backText: { fontSize: 13 },
});

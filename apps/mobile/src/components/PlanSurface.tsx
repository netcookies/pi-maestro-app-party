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
import { useI18n, type I18nDictionary } from "../i18n";
import { normalizePlanAction } from "../plan-actions";

interface Props {
  request: DesktopPlanRequest;
  target: SessionTargetIdentity;
  initialDraft?: string;
  onResponse: (response: DesktopPlanResponse, target: SessionTargetIdentity) => void;
  onCancel: (request: DesktopPlanRequest, target: SessionTargetIdentity) => void;
}

function actionLabel(action: string, t: I18nDictionary): string {
  switch (action) {
    case "execute": return t.planActionExecute;
    case "modify": return t.planActionModify;
    case "continue": return t.planActionContinue;
    case "refine": return t.planActionRefine;
    case "rollback": return t.planActionRollback;
    case "exit-plan": return t.planActionExit;
    case "close": return t.planActionClose;
    default: return action;
  }
}

export function PlanSurface({ request, target, initialDraft, onResponse, onCancel }: Props) {
  const { theme } = useTheme();
  const { t } = useI18n();
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
    return [...new Set(available.map(normalizePlanAction))];
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
      decision: { action: "continue", discussion: discussion.trim() },
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
              <Text style={[styles.title, { color: theme.text }]}>{request.kind === "review" ? t.planReviewTitle : t.planConfirmTitle}</Text>
              <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>{request.pathLabel} · {t.planRevision} {request.revision}</Text>
            </View>
            <TouchableOpacity
              onPress={() => onCancel(request, target)}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={t.planCancel}
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
              accessibilityLabel={t.planEditor}
            />
          ) : null}

          {discussing ? (
            <TextInput
              multiline
              value={discussion}
              onChangeText={setDiscussion}
              editable={!submitting}
              placeholder={t.planDiscussionPlaceholder}
              placeholderTextColor={theme.muted}
              textAlignVertical="top"
              style={[styles.editor, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
              accessibilityLabel={t.planDiscussionInput}
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
                {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>{t.planSaveEdit}</Text>}
              </TouchableOpacity>
            ) : discussing ? (
              <TouchableOpacity
                onPress={submitDiscussion}
                disabled={submitting || discussion.trim().length === 0}
                style={[styles.primary, { backgroundColor: theme.accent, opacity: submitting || discussion.trim().length === 0 ? 0.45 : 1 }]}
                accessibilityRole="button"
              >
                <Text style={styles.primaryText}>{t.planSendDiscussion}</Text>
              </TouchableOpacity>
            ) : (
              actions.map((action) => (
                <TouchableOpacity
                  key={action}
                  onPress={() => action === "modify" ? setEditing(true) : action === "continue" ? setDiscussing(true) : submitDecision(action)}
                  disabled={submitting}
                  style={[styles.action, { borderColor: theme.border, backgroundColor: theme.inputBg, opacity: submitting ? 0.5 : 1 }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.actionText, { color: theme.text }]}>{actionLabel(action, t)}</Text>
                </TouchableOpacity>
              ))
            )}
            {(editing || discussing) ? (
              <TouchableOpacity onPress={() => { setEditing(false); setDiscussing(false); }} disabled={submitting} style={styles.backButton}>
                <Text style={[styles.backText, { color: theme.muted }]}>{t.planBackPreview}</Text>
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

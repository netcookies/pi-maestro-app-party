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
import type {
  MobilePlanRefineAction,
  MobilePlanRefineRole,
} from "@maestro-mobile/mobile-sdk/protocol";
import type { PlanRefineState } from "@maestro-mobile/mobile-sdk";
import { useTheme } from "../theme";
import { useI18n, type I18nDictionary } from "../i18n";
import { normalizePlanAction } from "../plan-actions";
import { ChatMarkdown } from "./chat/ChatMarkdown";
import { MarkdownExpandContent, type MarkdownExpandRequest } from "./chat/MarkdownExpandViewer";

export interface PlanSurfaceProps {
  request: DesktopPlanRequest;
  target: SessionTargetIdentity;
  initialDraft?: string;
  onResponse: (response: DesktopPlanResponse, target: SessionTargetIdentity) => void;
  onCancel: (request: DesktopPlanRequest, target: SessionTargetIdentity) => void;
  /**
   * When true, Review & Refine runs as an in-modal native panel.
   * When false, attempting to refine displays a clear unavailable notice without closing the Plan.
   * When undefined, falls back to legacy TUI delegation.
   */
  supportsRefine?: boolean;
  onRefineAction?: (action: MobilePlanRefineAction, target: SessionTargetIdentity) => Promise<unknown>;
  refineState?: PlanRefineState;
  refineTarget?: SessionTargetIdentity;
}

const REFINE_ROLES: MobilePlanRefineRole[] = ["reviewer", "decomposer", "optimizer", "brainstormer"];

function roleLabel(role: MobilePlanRefineRole, t: I18nDictionary): string {
  switch (role) {
    case "reviewer": return t.planRefineRoleReviewer;
    case "decomposer": return t.planRefineRoleDecomposer;
    case "optimizer": return t.planRefineRoleOptimizer;
    case "brainstormer": return t.planRefineRoleBrainstormer;
    default: return role;
  }
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

export function PlanSurface({
  request,
  target,
  initialDraft,
  onResponse,
  onCancel,
  supportsRefine,
  onRefineAction,
  refineState,
  refineTarget,
}: PlanSurfaceProps) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft ?? request.markdown);
  const [discussion, setDiscussion] = useState("");
  const [editing, setEditing] = useState(request.kind === "review");
  const [discussing, setDiscussing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<MarkdownExpandRequest | null>(null);

  // Native Review & Refine state
  const [nativeRefineOpen, setNativeRefineOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<MobilePlanRefineRole>("reviewer");
  const [refineInstructions, setRefineInstructions] = useState("");
  const [refineUnavailableNotice, setRefineUnavailableNotice] = useState(false);
  const [legacyRefiningNotice, setLegacyRefiningNotice] = useState(false);
  const [cancelAfterSnapshot, setCancelAfterSnapshot] = useState(false);

  React.useEffect(() => {
    setExpanded(null);
    setSubmitting(false);
    setNativeRefineOpen(false);
    setRefineUnavailableNotice(false);
    setLegacyRefiningNotice(false);
  }, [request.requestId, request.revision]);

  React.useEffect(() => {
    setDraft(initialDraft ?? request.markdown);
  }, [request.requestId, request.revision, initialDraft, request.markdown]);

  const liveRefineCandidate = refineState?.kind === "live"
    && refineTarget?.sessionId === target.sessionId
    && refineTarget.endpointId === target.endpointId
    && refineTarget.normalizedCwd === target.normalizedCwd
    && refineTarget.processGeneration === target.processGeneration
    ? refineState : undefined;
  const liveRefine = liveRefineCandidate?.snapshot.revision === request.revision ? liveRefineCandidate : undefined;
  const latestTurn = liveRefine?.turns.at(-1);
  const isRunning = liveRefine?.snapshot.status === "running";
  const refineReady = liveRefine?.snapshot.status === "ready";
  const revisionMismatch = liveRefineCandidate !== undefined && liveRefineCandidate.snapshot.revision !== request.revision;
  React.useEffect(() => {
    if (!cancelAfterSnapshot || !liveRefine || isRunning) return;
    void dispatchRefineAction({ action: "cancel" });
    setCancelAfterSnapshot(false);
  }, [cancelAfterSnapshot, liveRefine, isRunning]);

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

  const handleRefinePress = (): void => {
    if (supportsRefine === true) {
      setRefineUnavailableNotice(false);
      setNativeRefineOpen(true);
      onResponse({
        type: "desktop_plan_response",
        requestId: request.requestId,
        kind: request.kind,
        status: "decision",
        decision: { action: "refine" },
      }, target);
      return;
    }
    if (supportsRefine === false) {
      setRefineUnavailableNotice(true);
      return;
    }
    // Legacy fallback when caller doesn't specify capability support
    setLegacyRefiningNotice(true);
    submitDecision("refine");
  };

  const dispatchRefineAction = (payload: MobilePlanRefineAction["action"]): Promise<unknown> => {
    if (!onRefineAction) return Promise.resolve(undefined);
    const actionId = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const action: MobilePlanRefineAction = {
      type: "plan_refine_action",
      refineSessionId: liveRefine?.snapshot.refineSessionId ?? `refine-${request.requestId}`,
      planRequestId: liveRefine?.snapshot.planRequestId ?? request.requestId,
      operationId: liveRefine?.snapshot.operationId ?? 1,
      revision: request.revision,
      actionId,
      action: payload,
    };
    return onRefineAction(action, target);
  };

  const handleRunRole = async (): Promise<void> => {
    if (isRunning) return;
    await dispatchRefineAction({ action: "select_role", role: selectedRole });
    await dispatchRefineAction({ action: "run", userInput: refineInstructions.trim() });
  };

  const handleApplyResult = (): void => {
    if (!latestTurn?.turnId) return;
    dispatchRefineAction({ action: "apply", turnId: latestTurn.turnId });
  };

  const handleDiscardResult = (): void => {
    dispatchRefineAction({ action: "discard" });
  };

  const closeNativeRefine = (): void => {
    if (liveRefine && !isRunning) void dispatchRefineAction({ action: "cancel" });
    else if (!liveRefine) setCancelAfterSnapshot(true);
    setNativeRefineOpen(false);
  };

  return (
    <Modal transparent={!expanded} animationType="fade" visible onRequestClose={() => {
      if (expanded) setExpanded(null);
      else if (nativeRefineOpen) closeNativeRefine();
      else if (!submitting) onCancel(request, target);
    }}>
      {expanded ? (
        <MarkdownExpandContent visible title={expanded.title} theme={theme} actions={expanded.actions} onClose={() => setExpanded(null)}>
          {expanded.children}
        </MarkdownExpandContent>
      ) : (
      <View style={styles.overlay}>
        <View style={[styles.surface, { backgroundColor: theme.cardBg ?? theme.bg, borderColor: theme.border }]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={[styles.title, { color: theme.text }]}>
                {nativeRefineOpen
                  ? t.planActionRefine
                  : request.kind === "review" ? t.planReviewTitle : t.planConfirmTitle}
              </Text>
              <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
                {request.pathLabel} · {t.planRevision} {request.revision}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                if (nativeRefineOpen) closeNativeRefine();
                else onCancel(request, target);
              }}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={t.planCancel}
              style={styles.closeButton}
            >
              <Text style={[styles.close, { color: theme.muted }]}>×</Text>
            </TouchableOpacity>
          </View>

          {/* Native Review & Refine Panel Mode */}
          {nativeRefineOpen ? (
            <View style={styles.refineContainer}>
              {/* Role selection grid: 2x2 so each role label stays on one line */}
              <View style={styles.roleGrid}>
                {REFINE_ROLES.map((role) => {
                  const active = selectedRole === role;
                  return (
                    <TouchableOpacity
                      key={role}
                      onPress={() => {
                        setSelectedRole(role);
                        dispatchRefineAction({ action: "select_role", role });
                      }}
                      disabled={!refineReady || isRunning}
                      style={[
                        styles.roleTab,
                        {
                          borderColor: active ? theme.accent : theme.border,
                          backgroundColor: active ? (theme.inputBg ?? theme.border) : "transparent",
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={roleLabel(role, t)}
                    >
                      <Text
                        style={[
                          styles.roleTabText,
                          { color: active ? theme.accent : theme.muted, fontWeight: active ? "700" : "500" },
                        ]}
                        numberOfLines={1}
                      >
                        {roleLabel(role, t)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Revision mismatch / conflict warning */}
              {revisionMismatch ? (
                <Text style={[styles.conflictBanner, { color: theme.error ?? "#E53E3E" }]}>
                  {t.planRefineConflict}
                </Text>
              ) : null}

              {/* Output Preview */}
              <ScrollView style={[styles.refinePreview, { borderColor: theme.border }]} contentContainerStyle={styles.previewContent}>
                {latestTurn?.output ? (
                  <ChatMarkdown content={latestTurn.output} onExpand={setExpanded} />
                ) : (
                  <Text style={[styles.emptyOutput, { color: theme.muted }]}>
                    {t.planRefineOutput}: —
                  </Text>
                )}
              </ScrollView>

              {/* Additional instruction input */}
              <TextInput
                value={refineInstructions}
                onChangeText={setRefineInstructions}
                editable={!isRunning}
                placeholder={t.planRefineInputPlaceholder}
                placeholderTextColor={theme.muted}
                style={[styles.refineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
                accessibilityLabel={t.planRefineInputPlaceholder}
              />

              {/* Refine actions: vertical stack, matching the Plan action layout */}
              <View style={styles.refineActions}>
                <TouchableOpacity
                  onPress={handleRunRole}
                  disabled={!refineReady || isRunning}
                  style={[styles.primary, { backgroundColor: theme.accent, opacity: isRunning ? 0.6 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={isRunning ? t.planRefineRunning : t.planRefineRun}
                >
                  {isRunning ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.primaryText}>{t.planRefineRun}</Text>
                  )}
                </TouchableOpacity>

                {latestTurn ? (
                  <>
                    <TouchableOpacity
                      onPress={handleApplyResult}
                      disabled={!refineReady || isRunning}
                      style={[styles.action, { borderColor: theme.accent, backgroundColor: theme.inputBg }]}
                      accessibilityRole="button"
                      accessibilityLabel={t.planRefineApply}
                    >
                      <Text style={[styles.actionText, { color: theme.accent }]}>{t.planRefineApply}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={handleDiscardResult}
                      disabled={!refineReady || isRunning}
                      style={[styles.action, { borderColor: theme.border, backgroundColor: theme.inputBg }]}
                      accessibilityRole="button"
                      accessibilityLabel={t.planRefineDiscard}
                    >
                      <Text style={[styles.actionText, { color: theme.muted }]}>{t.planRefineDiscard}</Text>
                    </TouchableOpacity>
                  </>
                ) : null}
              </View>

              <TouchableOpacity
                onPress={closeNativeRefine}
                style={styles.backButton}
                accessibilityRole="button"
                accessibilityLabel={t.planRefineBack}
              >
                <Text style={[styles.backText, { color: theme.muted }]}>{t.planRefineBack}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            /* Normal Plan Preview / Edit / Discuss Mode */
            <>
              {!editing && !discussing ? (
                <ScrollView style={[styles.preview, { borderColor: theme.border }]} contentContainerStyle={styles.previewContent}>
                  <ChatMarkdown content={request.markdown} onExpand={setExpanded} />
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

              {/* Unavailable capability warning */}
              {refineUnavailableNotice ? (
                <Text style={[styles.refineStatus, { color: theme.error ?? "#E53E3E" }]}>
                  {t.planRefineUnavailable}
                </Text>
              ) : null}

              {legacyRefiningNotice ? (
                <Text style={[styles.refineStatus, { color: theme.muted }]}>
                  {t.planRefineOpened}
                </Text>
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
                      onPress={() => {
                        if (action === "modify") setEditing(true);
                        else if (action === "continue") setDiscussing(true);
                        else if (action === "refine") handleRefinePress();
                        else submitDecision(action);
                      }}
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
            </>
          )}
        </View>
      </View>
      )}
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
  editor: { minHeight: 240, maxHeight: 400, borderWidth: 1, borderRadius: 6, padding: 12, fontSize: 14, lineHeight: 21 },
  actions: { gap: 8 },
  action: { minHeight: 44, borderWidth: 1, borderRadius: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  actionText: { fontSize: 14, fontWeight: "600" },
  primary: { minHeight: 44, borderRadius: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  refineStatus: { fontSize: 12, lineHeight: 18, textAlign: "center", paddingVertical: 6 },
  backButton: { minHeight: 36, alignItems: "center", justifyContent: "center" },
  backText: { fontSize: 13 },
  refineContainer: { gap: 12 },
  roleGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  roleTab: { flexGrow: 1, minWidth: "46%", minHeight: 36, borderWidth: 1, borderRadius: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  roleTabText: { fontSize: 12 },
  refinePreview: { maxHeight: 240, minHeight: 120, borderWidth: 1, borderRadius: 6 },
  emptyOutput: { fontSize: 13, fontStyle: "italic", padding: 8 },
  refineInput: { minHeight: 40, maxHeight: 80, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, fontSize: 13 },
  refineActions: { gap: 8 },
  conflictBanner: { fontSize: 12, fontWeight: "600", textAlign: "center" },
});

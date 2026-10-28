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
import { MinimizedDialogPill } from "./MinimizedDialogPill";
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
  /**
   * Lists the models the session may run a refine role with. The refine panel
   * mirrors the TUI's `2. Model [...]` row, so the phone can change the model
   * before running instead of being locked to whatever desktop picked.
   */
  onListModels?: (sessionId: string) => Promise<RefineModelOption[]>;
  /** The main session's model (`provider/id`); the refine panel defaults to it. */
  sessionModel?: string;
  initialRefineOpen?: boolean;
  refineState?: PlanRefineState;
  refineTarget?: SessionTargetIdentity;
}

export interface RefineModelOption {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
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
  onListModels,
  sessionModel,
  initialRefineOpen,
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
  // 最小化：弹窗收成右侧悬浮按钮，便于先阅读会话正文再裁决
  const [minimized, setMinimized] = useState(false);

  // Native Review & Refine state
  const [nativeRefineOpen, setNativeRefineOpen] = useState(initialRefineOpen ?? false);
  const [selectedRole, setSelectedRole] = useState<MobilePlanRefineRole>("reviewer");
  const [refineInstructions, setRefineInstructions] = useState("");
  const [refineUnavailableNotice, setRefineUnavailableNotice] = useState(false);
  const [legacyRefiningNotice, setLegacyRefiningNotice] = useState(false);
  const [cancelAfterSnapshot, setCancelAfterSnapshot] = useState(false);
  // Model row mirrors the TUI's `2. Model [...]` entry.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<RefineModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  /** Optimistic local pick; the Host echoes it back via a re-broadcast snapshot. */
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);

  React.useEffect(() => {
    setExpanded(null);
    setSubmitting(false);
    setNativeRefineOpen(initialRefineOpen ?? false);
    setRefineUnavailableNotice(false);
    setLegacyRefiningNotice(false);
    setCancelAfterSnapshot(false);
  }, [request.requestId, request.revision, initialRefineOpen]);

  React.useEffect(() => {
    setDraft(initialDraft ?? request.markdown);
  }, [request.requestId, request.revision, initialDraft, request.markdown]);

  const liveRefineCandidate = refineState?.kind === "live"
    && refineTarget?.sessionId === target.sessionId
    && refineTarget?.normalizedCwd === target.normalizedCwd
    ? refineState : undefined;
  const liveRefine = liveRefineCandidate?.snapshot.revision === request.revision ? liveRefineCandidate : undefined;
  // When Desktop opens Review & Refine, the remote mobile app is the mirror of that
  // overlay. It must open automatically as long as the snapshot is live, without
  // requiring the phone to have pressed the button first.
  const isRefineActive = liveRefine !== undefined
    && liveRefine.snapshot.status !== "discarded"
    && liveRefine.snapshot.status !== "applied"
    && liveRefine.snapshot.status !== "cancelled";
  const isRefineShowing = nativeRefineOpen || isRefineActive;
  const latestTurn = liveRefine?.turns.at(-1);
  const isRunning = liveRefine?.snapshot.status === "running";
  const refineReady = liveRefine ? liveRefine.snapshot.status !== "running" : true;
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
    // Safety fallback: if the host drops or rejects the response, reset submitting
    // after 3s so the user is not permanently trapped with greyed-out buttons.
    const timer = setTimeout(() => setSubmitting(false), 3000);
    try {
      onResponse(response, target);
    } catch {
      clearTimeout(timer);
      setSubmitting(false);
    }
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
    setCancelAfterSnapshot(false);
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
    await dispatchRefineAction({ action: "run", userInput: refineInstructions.trim() });
  };

  /** Current model as advertised by the live snapshot. */
  const currentModelId = liveRefine?.snapshot.currentModel || pickedModel || sessionModel || "";
  const currentModelLabel = (() => {
    if (!currentModelId) return t.planRefineModelNone;
    const fromSnapshot = liveRefine?.snapshot.modelOptions.find((opt) => opt.id === currentModelId)?.name;
    if (fromSnapshot) return fromSnapshot;
    const fromPicker = availableModels.find((m) => `${m.provider}/${m.id}` === currentModelId || m.id === currentModelId)?.name;
    return fromPicker ?? currentModelId;
  })();

  /** TUI parity: the role row cycles roles in place (`↔ change role`). */
  const handleCycleRole = (): void => {
    if (isRunning || !refineReady) return;
    const index = REFINE_ROLES.indexOf(selectedRole);
    const next = REFINE_ROLES[(index + 1) % REFINE_ROLES.length];
    setSelectedRole(next);
    void dispatchRefineAction({ action: "select_role", role: next });
  };

  const openModelPicker = async (): Promise<void> => {
    if (isRunning || !refineReady) return;
    setModelPickerOpen(true);
    setModelQuery("");
    if (availableModels.length > 0 || !onListModels) return;
    setLoadingModels(true);
    try {
      setAvailableModels(await onListModels(target.sessionId));
    } catch {
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleSelectModel = (option: RefineModelOption): void => {
    setModelPickerOpen(false);
    setPickedModel(`${option.provider}/${option.id}`);
    void dispatchRefineAction({ action: "select_model", model: `${option.provider}/${option.id}` });
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

  if (!expanded && minimized) {
    return (
      <MinimizedDialogPill
        label={t.dialogPlanPill}
        accessibilityLabel={t.dialogRestore}
        onRestore={() => setMinimized(false)}
      />
    );
  }

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
              onPress={() => setMinimized(true)}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={t.dialogMinimize}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.minimizeButton}
            >
              <Text style={[styles.minimizeText, { color: theme.muted }]}>—</Text>
            </TouchableOpacity>
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
              {/* Header mirrors the TUI's `role reviewer · turns 0` line. */}
              <View style={styles.refineHeader}>
                <Text style={[styles.refineHeaderText, { color: theme.muted }]} numberOfLines={1}>
                  {"role "}{selectedRole}{" · "}{liveRefine?.turns.length ?? 0}{" "}{t.planRefineTurns}
                </Text>
              </View>

              {revisionMismatch ? (
                <Text style={[styles.conflictBanner, { color: theme.error ?? "#E53E3E" }]}>
                  {t.planRefineConflict}
                </Text>
              ) : null}

              {/* Output preview (TUI preview pane) */}
              <ScrollView style={[styles.refinePreview, { borderColor: theme.border }]} contentContainerStyle={styles.previewContent}>
                {latestTurn?.output ? (
                  <ChatMarkdown content={latestTurn.output} onExpand={setExpanded} />
                ) : (
                  <Text style={[styles.emptyOutput, { color: theme.muted }]}>
                    {t.planRefineOutput}: —
                  </Text>
                )}
              </ScrollView>

              {/* Numbered rows, matching the TUI's 1-6 selection list. */}
              <View style={styles.refineRows}>
                <TouchableOpacity
                  onPress={handleCycleRole}
                  disabled={!refineReady || isRunning}
                  style={[styles.refineRow, { borderColor: theme.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={`1. ${t.planRefineRoleLabel} ${roleLabel(selectedRole, t)}`}
                >
                  <Text style={[styles.refineRowIndex, { color: theme.muted }]}>1.</Text>
                  <Text style={[styles.refineRowLabel, { color: theme.text }]}>{t.planRefineRoleLabel}</Text>
                  <Text style={[styles.refineRowValue, { color: theme.accent }]} numberOfLines={1}>
                    [{roleLabel(selectedRole, t)}]
                  </Text>
                  <Text style={[styles.refineRowChevron, { color: theme.muted }]}>↔</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => void openModelPicker()}
                  disabled={!refineReady || isRunning}
                  style={[styles.refineRow, { borderColor: theme.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={`2. ${t.planRefineModelLabel} ${currentModelLabel}`}
                >
                  <Text style={[styles.refineRowIndex, { color: theme.muted }]}>2.</Text>
                  <Text style={[styles.refineRowLabel, { color: theme.text }]}>{t.planRefineModelLabel}</Text>
                  <Text
                    style={[styles.refineRowValue, { color: currentModelId ? theme.accent : (theme.error ?? "#E53E3E") }]}
                    numberOfLines={1}
                  >
                    [{currentModelLabel}]
                  </Text>
                  <Text style={[styles.refineRowChevron, { color: theme.muted }]}>›</Text>
                </TouchableOpacity>

                <View style={[styles.refineRowColumn, { borderColor: theme.border }]}>
                  <View style={styles.refineRowInline}>
                    <Text style={[styles.refineRowIndex, { color: theme.muted }]}>3.</Text>
                    <Text style={[styles.refineRowLabel, { color: theme.text }]}>{t.planRefineRowInput}</Text>
                  </View>
                  <TextInput
                    value={refineInstructions}
                    onChangeText={setRefineInstructions}
                    editable={!isRunning}
                    placeholder={t.planRefineInputPlaceholder}
                    placeholderTextColor={theme.muted}
                    style={[styles.refineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
                    accessibilityLabel={t.planRefineInputPlaceholder}
                  />
                </View>

                <TouchableOpacity
                  onPress={() => void handleRunRole()}
                  disabled={!refineReady || isRunning}
                  style={[styles.refineRow, styles.refineRowPrimary, { borderColor: theme.accent, backgroundColor: theme.accent, opacity: isRunning ? 0.6 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={isRunning ? t.planRefineRunning : `4. ${t.planRefineRun}`}
                >
                  <Text style={[styles.refineRowIndex, { color: "#FFFFFF" }]}>4.</Text>
                  {isRunning ? (
                    <>
                      <ActivityIndicator color="#FFFFFF" size="small" />
                      <Text style={[styles.refineRowLabel, { color: "#FFFFFF", flex: 1 }]}>{t.planRefineRunning}</Text>
                    </>
                  ) : (
                    <Text style={[styles.refineRowLabel, { color: "#FFFFFF", flex: 1 }]}>{t.planRefineRun}</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleApplyResult}
                  disabled={!refineReady || isRunning || !latestTurn}
                  style={[styles.refineRow, { borderColor: theme.border, opacity: latestTurn ? 1 : 0.45 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`5. ${t.planRefineApply}`}
                >
                  <Text style={[styles.refineRowIndex, { color: theme.muted }]}>5.</Text>
                  <Text style={[styles.refineRowLabel, { color: theme.accent, flex: 1 }]}>{t.planRefineApply}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleDiscardResult}
                  disabled={!refineReady || isRunning}
                  style={[styles.refineRow, { borderColor: theme.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={`6. ${t.planRefineDiscard}`}
                >
                  <Text style={[styles.refineRowIndex, { color: theme.muted }]}>6.</Text>
                  <Text style={[styles.refineRowLabel, { color: theme.muted, flex: 1 }]}>{t.planRefineDiscard}</Text>
                </TouchableOpacity>
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

      {/* Model picker: the mobile counterpart of the TUI's `m model` prompt. */}
      {modelPickerOpen ? (
        <View style={styles.modelOverlay}>
          <View style={[styles.modelSheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
            <View style={styles.modelSheetHeader}>
              <Text style={[styles.modelSheetTitle, { color: theme.text }]}>{t.planRefineModelPicker}</Text>
              <TouchableOpacity
                onPress={() => setModelPickerOpen(false)}
                accessibilityRole="button"
                accessibilityLabel={t.planRefineCancel}
                style={styles.closeButton}
              >
                <Text style={[styles.close, { color: theme.muted }]}>×</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              value={modelQuery}
              onChangeText={setModelQuery}
              placeholder={t.planRefineModelSearch}
              placeholderTextColor={theme.muted}
              style={[styles.refineInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
              accessibilityLabel={t.planRefineModelSearch}
            />
            {loadingModels ? (
              <View style={styles.modelSheetEmpty}>
                <ActivityIndicator color={theme.accent} />
              </View>
            ) : (() => {
              const query = modelQuery.trim().toLowerCase();
              const filtered = query
                ? availableModels.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
                : availableModels;
              if (filtered.length === 0) {
                return (
                  <View style={styles.modelSheetEmpty}>
                    <Text style={[styles.modelSheetEmptyText, { color: theme.muted }]}>{t.planRefineNoModels}</Text>
                  </View>
                );
              }
              return (
                <ScrollView style={styles.modelSheetList} keyboardShouldPersistTaps="handled">
                  {filtered.map((option) => {
                    const key = `${option.provider}/${option.id}`;
                    const active = key === currentModelId || option.id === currentModelId;
                    return (
                      <TouchableOpacity
                        key={key}
                        onPress={() => handleSelectModel(option)}
                        style={[
                          styles.modelOption,
                          { borderColor: active ? theme.accent : theme.border, backgroundColor: active ? (theme.inputBg ?? theme.border) : "transparent" },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={key}
                      >
                        <Text style={[styles.modelOptionName, { color: active ? theme.accent : theme.text }]} numberOfLines={1}>
                          {option.name}
                        </Text>
                        <Text style={[styles.modelOptionMeta, { color: theme.muted }]} numberOfLines={1}>
                          {key}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              );
            })()}
          </View>
        </View>
      ) : null}
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
  minimizeButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  minimizeText: { fontSize: 16, fontWeight: "700" },
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
  refineHeader: { flexDirection: "row", alignItems: "center" },
  refineHeaderText: { fontSize: 12, fontWeight: "600" },
  refineRows: { gap: 6 },
  refineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  refineRowPrimary: { borderWidth: 1 },
  refineRowIndex: { fontSize: 12, fontWeight: "700", minWidth: 16 },
  refineRowLabel: { fontSize: 13, fontWeight: "600" },
  refineRowValue: { flex: 1, fontSize: 12, textAlign: "right" },
  refineRowChevron: { fontSize: 13 },
  refineRowColumn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  refineRowInline: { flexDirection: "row", alignItems: "center", gap: 8 },
  modelOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modelSheet: { width: "100%", maxHeight: "80%", borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  modelSheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modelSheetTitle: { fontSize: 15, fontWeight: "700" },
  modelSheetList: { maxHeight: 380 },
  modelSheetEmpty: { minHeight: 80, alignItems: "center", justifyContent: "center" },
  modelSheetEmptyText: { fontSize: 13 },
  modelOption: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, gap: 2, marginBottom: 6 },
  modelOptionName: { fontSize: 13, fontWeight: "600" },
  modelOptionMeta: { fontSize: 11 },
  roleGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  roleTab: { flexGrow: 1, minWidth: "46%", minHeight: 36, borderWidth: 1, borderRadius: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  roleTabText: { fontSize: 12 },
  refinePreview: { maxHeight: 240, minHeight: 120, borderWidth: 1, borderRadius: 6 },
  emptyOutput: { fontSize: 13, fontStyle: "italic", padding: 8 },
  refineInput: { minHeight: 40, maxHeight: 80, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, fontSize: 13 },
  refineActions: { gap: 8 },
  conflictBanner: { fontSize: 12, fontWeight: "600", textAlign: "center" },
});

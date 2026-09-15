import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { useTheme } from "../theme";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  id?: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  question: string;
  header?: string;
  selected: string[];
  text?: string;
  details?: Record<string, string>;
}

interface Props {
  questions: QuestionSpec[];
  onAnswer: (answers: AskAnswer[]) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

const NONE_OPTION_LABEL = "以上都不是";

/** 仅对 #RRGGBB 追加 8 位透明度后缀 */
function withAlpha(hex: string, alphaSuffix: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex + alphaSuffix : hex;
}

export function AskWizardDialog({ questions, onAnswer, onCancel }: Props) {
  const { theme } = useTheme();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // 补齐每个问题的选项列表（若有选项且不含“以上都不是”，则自动在末尾追加）
  const normalizedQuestions = React.useMemo(() => {
    return questions.map((q) => {
      const opts = q.options ?? [];
      if (opts.length === 0 || opts.some((o) => o.label === NONE_OPTION_LABEL)) {
        return { ...q, options: opts };
      }
      return {
        ...q,
        options: [...opts, { label: NONE_OPTION_LABEL, description: "自定义输入或暂无合适选项" }],
      };
    });
  }, [questions]);

  // 每道题的已选 label 列表及自定义说明
  const [answersState, setAnswersState] = useState<Array<{ selected: string[]; text: string }>>(() =>
    questions.map(() => ({ selected: [], text: "" })),
  );

  const total = normalizedQuestions.length;
  const currentQ = normalizedQuestions[step] ?? { question: "", options: [] };
  const currentAnswer = answersState[step] ?? { selected: [], text: "" };
  const options = currentQ.options ?? [];
  const isMulti = Boolean(currentQ.multiSelect);
  const hasOptions = options.length > 0;
  const isNoneSelected = currentAnswer.selected.includes(NONE_OPTION_LABEL);

  // 选项点击逻辑
  const handleSelectOption = (label: string) => {
    if (submitting) return;
    setAnswersState((prev) => {
      const next = [...prev];
      const cur = { ...next[step] };
      if (!isMulti) {
        // 单选：直接切换为该项
        cur.selected = [label];
      } else {
        // 多选
        if (label === NONE_OPTION_LABEL) {
          // 选中“以上都不是”时，互斥清空其他项
          cur.selected = cur.selected.includes(NONE_OPTION_LABEL) ? [] : [NONE_OPTION_LABEL];
        } else {
          // 选中常规项时，移除非选项
          const filtered = cur.selected.filter((s) => s !== NONE_OPTION_LABEL);
          if (filtered.includes(label)) {
            cur.selected = filtered.filter((s) => s !== label);
          } else {
            cur.selected = [...filtered, label];
          }
        }
      }
      next[step] = cur;
      return next;
    });
  };

  // 输入文本变更逻辑
  const handleChangeText = (text: string) => {
    setAnswersState((prev) => {
      const next = [...prev];
      next[step] = { ...next[step], text };
      return next;
    });
  };

  // 全选/反选（仅多选题）
  const handleToggleSelectAll = () => {
    if (!isMulti || options.length <= 1) return;
    const selectableLabels = options
      .map((o) => o.label)
      .filter((l) => l !== NONE_OPTION_LABEL);
    const isAllSelected = selectableLabels.every((l) => currentAnswer.selected.includes(l));
    setAnswersState((prev) => {
      const next = [...prev];
      next[step] = {
        ...next[step],
        selected: isAllSelected ? [] : selectableLabels,
      };
      return next;
    });
  };

  // 前进与后退
  const handleNext = () => {
    if (step < total - 1) {
      setStep((s) => s + 1);
    } else {
      // 提交全部回答
      handleSubmit();
    }
  };

  const handlePrev = () => {
    if (step > 0) {
      setStep((s) => s - 1);
    } else {
      onCancel();
    }
  };

  const handleSubmit = () => {
    if (submitting) return;
    setSubmitting(true);
    const finalAnswers: AskAnswer[] = normalizedQuestions.map((q, i) => {
      const ans = answersState[i] ?? { selected: [], text: "" };
      return {
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        selected: ans.selected,
        ...(ans.text.trim() ? { text: ans.text.trim() } : {}),
      };
    });

    Promise.resolve()
      .then(() => onAnswer(finalAnswers))
      .catch(() => {})
      .finally(() => setSubmitting(false));
  };

  return (
    <Modal transparent animationType="fade" visible>
      <View style={styles.overlay}>
        <View
          style={[
            styles.dialog,
            {
              backgroundColor: theme.cardBg ?? "#FFFFFF",
              borderColor: theme.border,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.25,
              shadowRadius: 20,
              elevation: 12,
            },
          ]}
        >
          {/* 顶部指示栏与 Breadcrumb */}
          <View style={styles.headerBar}>
            <View style={styles.badgeWrap}>
              <Text style={[styles.stepBadge, { color: theme.accent, backgroundColor: withAlpha(theme.accent, "22") }]}>
                {`第 ${step + 1} / ${total} 题`}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.breadWrap}>
              {normalizedQuestions.map((q, i) => (
                <Text
                  key={`b-${i}`}
                  style={[
                    styles.breadItem,
                    { color: i === step ? theme.text : theme.dim },
                    i === step && { fontWeight: "700" },
                  ]}
                >
                  {q.header || `题${i + 1}`}
                  {i < total - 1 ? " › " : ""}
                </Text>
              ))}
            </ScrollView>
          </View>

          {/* 题目内容 */}
          <Text style={[styles.questionTitle, { color: theme.text }]}>
            {currentQ.question}
          </Text>

          <Text style={[styles.modeHint, { color: theme.muted }]}>
            {isMulti
              ? "多选 · 支持点击勾选多项"
              : hasOptions
              ? "单选 · 请选择最贴合的一项"
              : "自由文本回复"}
          </Text>

          {/* 选项列表 */}
          {hasOptions ? (
            <ScrollView style={styles.optionsList} showsVerticalScrollIndicator>
              {isMulti && options.length > 2 && (
                <TouchableOpacity
                  style={[styles.selectAllBtn, { borderColor: theme.border }]}
                  onPress={handleToggleSelectAll}
                  accessibilityRole="button"
                >
                  <Text style={[styles.selectAllText, { color: theme.accent }]}>
                    {options.filter((o) => o.label !== NONE_OPTION_LABEL).every((o) => currentAnswer.selected.includes(o.label))
                      ? "取消全选"
                      : "一键全选"}
                  </Text>
                </TouchableOpacity>
              )}

              {options.map((opt, idx) => {
                const isSelected = currentAnswer.selected.includes(opt.label);
                return (
                  <TouchableOpacity
                    key={`${opt.label}-${idx}`}
                    style={[
                      styles.optionCard,
                      { backgroundColor: theme.bg, borderColor: theme.border },
                      isSelected && {
                        borderColor: theme.accent,
                        backgroundColor: withAlpha(theme.accent, "18"),
                      },
                    ]}
                    onPress={() => handleSelectOption(opt.label)}
                    accessibilityRole="button"
                    accessibilityLabel={opt.label}
                    accessibilityState={{ selected: isSelected }}
                  >
                    <View style={styles.optionHeader}>
                      <Text style={[styles.optionIndex, { color: isSelected ? theme.accent : theme.muted }]}>
                        {isSelected ? "✓" : `${idx + 1}.`}
                      </Text>
                      <Text
                        style={[
                          styles.optionLabel,
                          { color: isSelected ? theme.accent : theme.text },
                          isSelected && { fontWeight: "700" },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </View>
                    {opt.description ? (
                      <Text style={[styles.optionDesc, { color: theme.muted }]}>
                        {opt.description}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}

              {/* 当选中“以上都不是”时显示附加自定义输入 */}
              {isNoneSelected && (
                <View style={styles.customInputWrap}>
                  <Text style={[styles.inputHint, { color: theme.muted }]}>补充自定义说明：</Text>
                  <TextInput
                    style={[styles.customInput, { backgroundColor: theme.bg, color: theme.text, borderColor: theme.border }]}
                    value={currentAnswer.text}
                    onChangeText={handleChangeText}
                    placeholder="输入具体意见或方案…"
                    placeholderTextColor={theme.dim}
                    multiline
                  />
                </View>
              )}
            </ScrollView>
          ) : (
            /* 纯自由文本输入 */
            <View style={styles.freeInputBox}>
              <TextInput
                style={[styles.freeInput, { backgroundColor: theme.bg, color: theme.text, borderColor: theme.border }]}
                value={currentAnswer.text}
                onChangeText={handleChangeText}
                placeholder="请输入您的回答与要求…"
                placeholderTextColor={theme.dim}
                multiline
                numberOfLines={6}
                autoFocus
              />
            </View>
          )}

          {/* 底部操作区 */}
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.btnSecondary, { backgroundColor: theme.border }]}
              onPress={handlePrev}
              disabled={submitting}
              accessibilityRole="button"
            >
              <Text style={[styles.btnSecondaryText, { color: theme.text }]}>
                {step > 0 ? "‹ 上一题" : "取消"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btnPrimary, { backgroundColor: theme.buttonPrimary }]}
              onPress={handleNext}
              disabled={submitting}
              accessibilityRole="button"
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.btnPrimaryText}>
                  {step < total - 1 ? "下一题 ›" : "✓ 提交全部"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 20,
  },
  dialog: {
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    maxHeight: "85%",
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  badgeWrap: {
    marginRight: 8,
  },
  stepBadge: {
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: "hidden",
  },
  breadWrap: {
    flex: 1,
  },
  breadItem: {
    fontSize: 12,
  },
  questionTitle: {
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
    marginBottom: 6,
  },
  modeHint: {
    fontSize: 12,
    marginBottom: 12,
  },
  optionsList: {
    maxHeight: 320,
    marginBottom: 16,
  },
  selectAllBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: "flex-start",
    marginBottom: 8,
  },
  selectAllText: {
    fontSize: 12,
    fontWeight: "600",
  },
  optionCard: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1.5,
  },
  optionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  optionIndex: {
    fontSize: 14,
    fontWeight: "700",
    marginRight: 6,
    width: 20,
  },
  optionLabel: {
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  optionDesc: {
    fontSize: 12,
    marginTop: 4,
    marginLeft: 26,
    lineHeight: 16,
  },
  customInputWrap: {
    marginTop: 8,
    marginBottom: 6,
  },
  inputHint: {
    fontSize: 12,
    marginBottom: 4,
  },
  customInput: {
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    borderWidth: 1,
    minHeight: 54,
  },
  freeInputBox: {
    marginBottom: 16,
  },
  freeInput: {
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    borderWidth: 1,
    minHeight: 120,
    textAlignVertical: "top",
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  btnSecondary: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  btnSecondaryText: {
    fontSize: 15,
    fontWeight: "600",
  },
  btnPrimary: {
    flex: 1.6,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimaryText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
});

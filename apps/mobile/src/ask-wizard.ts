import type { ExtensionUiRequest, TimelineItem } from "@maestro-mobile/shared";
import type { AskAnswer, QuestionSpec } from "./components/AskWizardDialog";

export interface ActiveAskWizard {
  questions: QuestionSpec[];
  requestId?: string;
  dismissIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQuestion(value: unknown): QuestionSpec | undefined {
  if (!isRecord(value) || typeof value.question !== "string" || value.question.length === 0) return undefined;
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option) => {
        if (!isRecord(option) || typeof option.label !== "string") return [];
        return [{
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        }];
      })
    : undefined;
  return {
    question: value.question,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.header === "string" ? { header: value.header } : {}),
    ...(options ? { options } : {}),
    ...(typeof value.multiSelect === "boolean" ? { multiSelect: value.multiSelect } : {}),
  };
}

export function parseAskQuestions(value: unknown): QuestionSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value.flatMap((question) => {
    const parsed = parseQuestion(question);
    return parsed ? [parsed] : [];
  });
  return questions.length > 0 ? questions : undefined;
}

function timelineWizard(timeline: TimelineItem[]): { callId: string; questions: QuestionSpec[] } | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind !== "tool" || !item.toolName || (!item.toolName.includes("ask") && !item.toolName.includes("question"))) continue;
    const callId = item.toolCallId || item.id;
    if (item.status === "completed") continue;
    const args = item.toolArgs as Record<string, unknown> | undefined;
    const questions = parseAskQuestions(args?.questions);
    if (questions) return { callId, questions };
  }
  return undefined;
}

/** Select one wizard surface and pair its timeline/direct identities for duplicate suppression. */
export function selectActiveAskWizard(
  timeline: TimelineItem[],
  directRequest: ExtensionUiRequest | undefined,
  dismissedIds: ReadonlySet<string>,
): ActiveAskWizard | null {
  const fromTimeline = timelineWizard(timeline);
  const directQuestions = parseAskQuestions(directRequest?.questions);
  const pairedTimeline = fromTimeline && (!directQuestions || JSON.stringify(fromTimeline.questions) === JSON.stringify(directQuestions))
    ? fromTimeline
    : undefined;
  const pairedIds = [directRequest?.id, pairedTimeline?.callId].filter((id): id is string => Boolean(id));

  if (pairedIds.some((id) => dismissedIds.has(id))) return null;
  if (directRequest && directQuestions) {
    return { questions: directQuestions, requestId: directRequest.id, dismissIds: [...new Set(pairedIds)] };
  }
  if (fromTimeline && !dismissedIds.has(fromTimeline.callId)) {
    return {
      questions: fromTimeline.questions,
      ...(directRequest ? { requestId: directRequest.id } : {}),
      dismissIds: [...new Set(pairedIds)],
    };
  }
  return null;
}

export function buildAskWizardPayload(answers: AskAnswer[]): string {
  const summary = answers.map((answer, index) => {
    const chosen = answer.selected.join("、");
    const extra = answer.text ? ` (${answer.text})` : "";
    return `${index + 1}. ${answer.question} → ${chosen || "无"}${extra}`;
  }).join("\n");
  return JSON.stringify({ answers, summary });
}

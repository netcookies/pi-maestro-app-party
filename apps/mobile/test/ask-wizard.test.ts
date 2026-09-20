import { describe, expect, it } from "vitest";
import type { ExtensionUiRequest, TimelineItem } from "@maestro-mobile/shared";
import { buildAskWizardPayload, selectActiveAskWizard } from "../src/ask-wizard.js";

const questions = [
  { question: "Which approach?", header: "Approach", options: [{ label: "A", description: "First" }, { label: "B" }] },
  { question: "Why?", options: [] },
];

function direct(overrides: Partial<ExtensionUiRequest> = {}): ExtensionUiRequest {
  return { id: "request-1", sessionId: "session-1", method: "select", questions, ...overrides };
}

function timelineAsk(): TimelineItem {
  return {
    id: "tool-row",
    toolCallId: "tool-call-1",
    kind: "tool",
    text: "",
    createdAt: "",
    toolName: "ask-user-question",
    status: "running",
    toolArgs: { questions },
  };
}

describe("ask wizard source selection", () => {
  it("uses direct request questions when no timeline exists", () => {
    const active = selectActiveAskWizard([], direct(), new Set());
    expect(active).toMatchObject({ requestId: "request-1", dismissIds: ["request-1"] });
    expect(active?.questions).toHaveLength(2);
  });

  it("renders one direct wizard and pairs IDs when timeline and direct projections coexist", () => {
    const active = selectActiveAskWizard([timelineAsk()], direct(), new Set());
    expect(active?.requestId).toBe("request-1");
    expect(active?.dismissIds).toEqual(["request-1", "tool-call-1"]);
    expect(active?.questions[0].question).toBe("Which approach?");
  });

  it("uses the direct request ID for a timeline-backed wizard response", () => {
    const request = direct({ questions: undefined });
    const active = selectActiveAskWizard([timelineAsk()], request, new Set());
    expect(active).toMatchObject({ requestId: "request-1", dismissIds: ["request-1", "tool-call-1"] });
  });

  it("suppresses both projections after either paired ID is dismissed", () => {
    expect(selectActiveAskWizard([timelineAsk()], direct(), new Set(["request-1"]))).toBeNull();
    expect(selectActiveAskWizard([timelineAsk()], direct(), new Set(["tool-call-1"]))).toBeNull();
  });

  it("does not suppress a new direct ask when an unrelated timeline ask was dismissed", () => {
    const unrelated = direct({ id: "request-new", questions: [{ question: "Another choice?" }] });
    expect(selectActiveAskWizard([timelineAsk()], unrelated, new Set(["tool-call-1"]))?.requestId).toBe("request-new");
  });

  it("preserves the existing wizard JSON response shape", () => {
    const answers = [{ question: "Which approach?", selected: ["A"], text: "details" }];
    expect(JSON.parse(buildAskWizardPayload(answers))).toEqual({
      answers,
      summary: "1. Which approach? → A (details)",
    });
  });
});

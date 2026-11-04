import { describe, expect, it } from "vitest";
import { CommandOutcomeUnknownError, CommandFailedError } from "@maestro-mobile/mobile-sdk";
import {
  isFollowUpOutcomeUnknown,
  isUnknownFollowUpDraft,
  shouldClearFollowUpDraft,
} from "../src/follow-up-delivery";

describe("isFollowUpOutcomeUnknown", () => {
  it("treats lost responses and follow-up timeouts as unknown", () => {
    expect(isFollowUpOutcomeUnknown(new CommandOutcomeUnknownError("follow_up", "connection_lost"))).toBe(true);
    expect(isFollowUpOutcomeUnknown(new CommandOutcomeUnknownError("follow_up", "client_closed"))).toBe(true);
    expect(isFollowUpOutcomeUnknown(new Error("Command timeout: follow_up"))).toBe(true);
    expect(isFollowUpOutcomeUnknown(new Error("Command timeout: prompt"))).toBe(false);
  });

  it("preserves uncertain drafts and blocks accidental resubmission of the same text", () => {
    expect(shouldClearFollowUpDraft("check status", "check status", "unknown")).toBe(false);
    expect(shouldClearFollowUpDraft("check status", "check status", "stale")).toBe(false);
    expect(isUnknownFollowUpDraft("check status", "check status")).toBe(true);
    expect(isUnknownFollowUpDraft("check status again", "check status")).toBe(false);
  });

  it("clears only the submitted draft, preserving newer text typed while the command was pending", () => {
    expect(shouldClearFollowUpDraft("first", "first", undefined)).toBe(true);
    expect(shouldClearFollowUpDraft("first", "second", undefined)).toBe(false);
  });

  it("distinguishes an unknown Host result from an explicit rejection", () => {
    const unknown = new CommandFailedError({
      type: "command_result", in_reply_to: "unknown", ok: false, status: "unknown", revision: 1,
      error: { code: "target_unavailable" },
    });
    const failed = new CommandFailedError({
      type: "command_result", in_reply_to: "failed", ok: false, status: "failed", revision: 1,
      error: { code: "delivery_failed" },
    });
    expect(isFollowUpOutcomeUnknown(unknown)).toBe(true);
    expect(isFollowUpOutcomeUnknown(failed)).toBe(false);
  });
});

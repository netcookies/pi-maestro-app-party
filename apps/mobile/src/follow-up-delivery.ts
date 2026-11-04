import { CommandOutcomeUnknownError, CommandFailedError } from "@maestro-mobile/mobile-sdk";

export function isFollowUpOutcomeUnknown(error: unknown): boolean {
  return error instanceof CommandOutcomeUnknownError
    || error instanceof CommandFailedError && error.status === "unknown"
    || error instanceof Error && error.message === "Command timeout: follow_up";
}

export function isUnknownFollowUpDraft(message: string, unknownDraft: string | null): boolean {
  return unknownDraft !== null && message.trim() === unknownDraft;
}

export function shouldClearFollowUpDraft(
  submittedMessage: string,
  currentDraft: string,
  outcome: "unknown" | "stale" | void,
): boolean {
  return outcome === undefined && currentDraft.trim() === submittedMessage;
}

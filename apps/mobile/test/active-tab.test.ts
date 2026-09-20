import { describe, expect, it } from "vitest";
import type { HostSessionSummary, SessionControlMode, SessionRuntimeStatus } from "@maestro-mobile/shared";
import { isCurrentSessionSummary } from "../src/host-session-pagination.js";

function session(runtimeStatus: SessionRuntimeStatus, mode: SessionControlMode): HostSessionSummary {
  return {
    id: `${runtimeStatus}-${mode}`,
    sessionId: `${runtimeStatus}-${mode}`,
    endpointId: mode,
    runtimeStatus,
    cwd: "/work/app",
    cwdName: "app",
    path: "/work/app/session.jsonl",
    title: "Session",
    messageCount: 0,
    updatedAt: "2026-09-17T00:00:00.000Z",
    presentation: {
      role: "session",
      visibility: "session_list",
      control: {
        mode,
        canPrompt: mode !== "readonly",
        canSteer: mode !== "readonly",
        canFollowUp: mode !== "readonly",
        canAbort: mode !== "readonly",
        canAnswerAsk: false,
      },
      revision: 1,
    },
  };
}

describe("Current session filtering", () => {
  const statuses: SessionRuntimeStatus[] = ["running", "idle", "sleeping", "history"];
  const modes: SessionControlMode[] = ["host", "desktop_plugin", "readonly"];

  it.each(statuses.flatMap((runtimeStatus) => modes.map((mode) => ({ runtimeStatus, mode }))))(
    "derives $runtimeStatus + $mode from the runtime and visibility axes",
    ({ runtimeStatus, mode }) => {
      const expected = runtimeStatus !== "history";
      expect(isCurrentSessionSummary(session(runtimeStatus, mode))).toBe(expected);
    },
  );

  it("does not infer current status when the server presentation is absent", () => {
    expect(isCurrentSessionSummary({ ...session("running", "host"), presentation: undefined })).toBe(false);
  });
});

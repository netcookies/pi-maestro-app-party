import { describe, expect, it } from "vitest";
import { classifyCustomMessage, isSystemContinuationPrompt } from "../src/timeline-notice.js";

describe("classifyCustomMessage", () => {
  it("classifies peer messages with priority to details.body and strips duplicate direction prefix", () => {
    const entry = {
      type: "custom_message",
      customType: "mb-peer",
      content: "← 来自 peer abc12345\n\n【硬门禁】收到来自 peer 的协作请求。在执行前请询问授权。\n回复可调用 mb-peer tool。",
      details: {
        direction: "in",
        peer: { sessionId: "peer-session-id" },
        body: "继续联调一下接口",
      },
    };
    expect(classifyCustomMessage(entry)).toEqual({
      kind: "notice",
      noticeKind: "peer",
      text: "继续联调一下接口",
      source: "peer-ses",
    });
  });

  it("keeps the peer short id even when details.peer is absent", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "mb-peer",
      content: "← 来自 peer 3f9a2c\n\nHost 侧字段已确认。",
    })).toEqual({
      kind: "notice",
      noticeKind: "peer",
      text: "Host 侧字段已确认。",
      source: "3f9a2c",
    });

    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "teammate-started",
      content: "● @explorer spawned @researcher",
    })).not.toHaveProperty("source");
  });

  it("classifies teammate started and complete as teammate notices", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "teammate-started",
      content: "● @explorer spawned @researcher",
    })).toEqual({
      kind: "notice",
      noticeKind: "teammate",
      text: "● @explorer spawned @researcher",
    });

    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "teammate-complete",
      content: "@explorer result ready · 1234\nagent://pub-1\nAll tests passed.",
    })).toEqual({
      kind: "notice",
      noticeKind: "teammate",
      text: "@explorer result ready · 1234\nagent://pub-1\nAll tests passed.",
    });
  });

  it("classifies background jobs and loop events", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "bash-bg-complete",
      content: "▶ 后台命令已完成：npm test（退出码 0，耗时 3.2s）",
    })).toEqual({
      kind: "notice",
      noticeKind: "background",
      text: "▶ 后台命令已完成：npm test（退出码 0，耗时 3.2s）",
    });

    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "loop-event",
      content: "⟳ Loop loop-1 completed (10/10 runs)",
    })).toEqual({
      kind: "notice",
      noticeKind: "loop",
      text: "⟳ Loop loop-1 completed (10/10 runs)",
    });
  });

  it("classifies system / MCP / closeout requests", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "knowledge-closeout-request",
      content: "◆ 请在收口时运行知识审查并确认候选发布",
    })).toEqual({
      kind: "notice",
      noticeKind: "system",
      text: "◆ 请在收口时运行知识审查并确认候选发布",
    });
  });

  it("classifies active-goal continuation prompts as system notices", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "unknown",
      content: "Continue the active goal: keep going until the acceptance criteria pass.",
    })).toEqual({
      kind: "notice",
      noticeKind: "system",
      text: "Continue the active goal: keep going until the acceptance criteria pass.",
    });

    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "unknown",
      content: "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.\n\n[maestro-recovery-delivery:33168ea1db5ffa423d543ad3]",
    })).toEqual({
      kind: "notice",
      noticeKind: "system",
      text: "Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.\n\n[maestro-recovery-delivery:33168ea1db5ffa423d543ad3]",
    });

    expect(isSystemContinuationPrompt("Continue the active goal: keep going until the acceptance criteria pass.")).toBe(true);
    expect(isSystemContinuationPrompt("Continue the interrupted task from the compacted session checkpoint. Do not wait for another user request.\n\n[maestro-recovery-delivery:33168ea1db5ffa423d543ad3]")).toBe(true);
    expect(isSystemContinuationPrompt("hello user message")).toBe(false);
    expect(isSystemContinuationPrompt("")).toBe(false);
  });

  it("keeps unrelated unknown custom messages as user messages", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "unknown",
      content: "I want to continue the active goal tomorrow.",
    })).toEqual({ kind: "user", text: "I want to continue the active goal tomorrow." });
  });

  it("conservatively keeps unknown customType as user to avoid irreversible downgrade of user input", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "legacy-user-inbox-input",
      content: "用户通过早期手机信箱输入的内容",
    })).toEqual({
      kind: "user",
      text: "用户通过早期手机信箱输入的内容",
    });
  });

  it("extracts text from TextContent block arrays", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "teammate-started",
      content: [
        { type: "text", text: "第一行内容" },
        { type: "text", text: "第二行内容" },
      ],
    })).toEqual({
      kind: "notice",
      noticeKind: "teammate",
      text: "第一行内容\n第二行内容",
    });
  });

  it("preserves legacy \\n---\\n split only when [workspace:message] prefix is present", () => {
    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "teammate-message",
      content: "[workspace:message] header\n---\n实际正文",
    })).toEqual({
      kind: "notice",
      noticeKind: "teammate",
      text: "实际正文",
    });

    expect(classifyCustomMessage({
      type: "custom_message",
      customType: "teammate-message",
      content: "没有 marker\n---\n这里的横线是普通 Markdown 分隔线，不能被切掉",
    })).toEqual({
      kind: "notice",
      noticeKind: "teammate",
      text: "没有 marker\n---\n这里的横线是普通 Markdown 分隔线，不能被切掉",
    });
  });
});

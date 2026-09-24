import { describe, expect, it } from "vitest";
import type { HostError } from "@maestro-mobile/shared";
import { sessionErrorPresentation } from "../src/session-error.js";

const screenshotError: HostError = {
  code: "bad_response_status_code",
  type: "bad_response_status_code",
  message: "openai_error",
  source: "provider",
  provider: "my-sub2api-opencode",
  httpStatus: 400,
  details: { sourceText: 'Error: my-sub2api-opencode API error (400): {"message":"openai_error","type":"bad_response_status_code","code":"bad_response_status_code"}' },
};

describe("sessionErrorPresentation", () => {
  it("keeps the provider, explicit HTTP 400 and structured provider fields from the TUI error", () => {
    expect(sessionErrorPresentation(screenshotError, "fallback")).toEqual({
      title: "模型请求失败",
      provider: "my-sub2api-opencode",
      httpStatus: 400,
      message: "openai_error",
      type: "bad_response_status_code",
      code: "bad_response_status_code",
      sourceText: 'Error: my-sub2api-opencode API error (400): {"message":"openai_error","type":"bad_response_status_code","code":"bad_response_status_code"}',
    });
  });

  it("keeps explicit HTTP 500 and never invents a status for unknown provider errors", () => {
    expect(sessionErrorPresentation({ ...screenshotError, httpStatus: 500 }, "fallback").httpStatus).toBe(500);
    const { httpStatus: _status, ...withoutStatus } = screenshotError;
    expect(sessionErrorPresentation(withoutStatus, "fallback")).not.toHaveProperty("httpStatus");
  });

  it("preserves legacy string-only errors without inventing provider metadata", () => {
    expect(sessionErrorPresentation(undefined, "legacy prompt failed")).toEqual({
      title: "错误",
      message: "legacy prompt failed",
    });
  });
});

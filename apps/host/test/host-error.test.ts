import { describe, expect, it } from "vitest";
import { normalizeHostError } from "../src/host-error.js";

describe("normalizeHostError", () => {
  it("extracts recognized provider status and JSON fields without losing source text", () => {
    const error = normalizeHostError(new Error('Error: my-sub2api-opencode API error (400): {"message":"openai_error","type":"bad_response_status_code","code":"bad_response_status_code"}'));
    expect(error).toMatchObject({
      source: "provider", httpStatus: 400, provider: "my-sub2api-opencode",
      message: "openai_error", type: "bad_response_status_code", code: "bad_response_status_code",
    });
    expect(error.details).toMatchObject({ sourceText: expect.stringContaining("API error (400)") });
  });

  it("uses only explicit status fields and leaves unknown status absent", () => {
    expect(normalizeHostError(Object.assign(new Error("failed"), { statusCode: 500 }))).toMatchObject({ httpStatus: 500 });
    expect(normalizeHostError(new Error("API error (500): failed"))).toMatchObject({ httpStatus: 500 });
    expect(normalizeHostError(new Error("HTTP 400 failed"))).not.toHaveProperty("httpStatus");
  });

  it("sanitizes quoted JSON credentials and complete bearer values", () => {
    const error = normalizeHostError(new Error('{"token":"json-secret","authorization":"Bearer bearer-secret"}'));
    expect(JSON.stringify(error)).not.toContain("json-secret");
    expect(JSON.stringify(error)).not.toContain("bearer-secret");
  });

  it("preserves plain-object fields and uses source-specific fallback codes", () => {
    expect(normalizeHostError({ message: "bad request", code: "bad_request", type: "provider_error", requestId: "req-1" })).toMatchObject({
      code: "bad_request", message: "bad request", type: "provider_error", requestId: "req-1",
    });
    expect(normalizeHostError(new Error("failed"), "command").code).toBe("host_command_failed");
    expect(normalizeHostError(new Error("failed"), "transport").code).toBe("desktop_confirmation_unavailable");
  });

  it("sanitizes secrets and bounds the retained source text", () => {
    const error = normalizeHostError(new Error(`token=supersecret ${"x".repeat(2000)}`));
    expect(JSON.stringify(error)).not.toContain("supersecret");
    expect((error.details as { sourceText: string }).sourceText.length).toBeLessThanOrEqual(1200);
  });
});

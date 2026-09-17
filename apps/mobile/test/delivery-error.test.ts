import { describe, expect, it } from "vitest";
import { describeSendFailure } from "../src/delivery-error.js";

describe("describeSendFailure", () => {
  it("maps Desktop Plugin delivery failures to actionable text", () => {
    expect(describeSendFailure("no_model_selected")).toContain("未选择模型");
    expect(describeSendFailure("missing_model_auth")).toContain("凭据");
    expect(describeSendFailure("delivery_failed")).toContain("未投递");
  });

  it("maps transport and capability failures", () => {
    expect(describeSendFailure("target_unavailable")).toContain("不可用");
    expect(describeSendFailure("capability_mismatch")).toContain("不支持");
    expect(describeSendFailure("deadline_exceeded")).toContain("未及时响应");
    expect(describeSendFailure("desktop_confirmation_unavailable")).toContain("连接已中断");
    expect(describeSendFailure("host_command_failed")).toContain("主机执行失败");
  });

  it("matches a code embedded in a longer error string", () => {
    expect(describeSendFailure(new Error("Error: delivery_failed"))).toContain("未投递");
  });

  it("never swallows an unknown failure", () => {
    expect(describeSendFailure("boom")).toBe("发送失败：boom");
    expect(describeSendFailure(new Error("boom"))).toBe("发送失败：boom");
    expect(describeSendFailure(undefined)).toBe("发送失败：未知原因");
    expect(describeSendFailure("")).toBe("发送失败：未知原因");
  });
});

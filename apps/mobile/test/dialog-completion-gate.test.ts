import { describe, expect, it } from "vitest";

/**
 * 校验 ExtensionUiDialog / AskWizardDialog 的禁用规则：
 * 未真正作答时提交按钮禁止高亮与点击。
 */
describe("dialog answer completion gate", () => {
  const NONE_OPTION_LABEL = "以上都不是";

  function isAnswerComplete(selected: string[], text: string, hasOptions: boolean): boolean {
    if (text.trim().length > 0) return true;
    if (!hasOptions) return false;
    return selected.some((s) => s !== NONE_OPTION_LABEL);
  }

  it("requires an option to be picked or text to be supplied", () => {
    // 初始状态：未选择，未输入 → 不完整
    expect(isAnswerComplete([], "", true)).toBe(false);
    expect(isAnswerComplete([], "   ", true)).toBe(false);

    // 选中真实选项 → 完整
    expect(isAnswerComplete(["选项 A"], "", true)).toBe(true);
    expect(isAnswerComplete(["选项 A", "选项 B"], "", true)).toBe(true);

    // 只选「以上都不是」，但没有填补充文本 → 不完整
    expect(isAnswerComplete([NONE_OPTION_LABEL], "", true)).toBe(false);

    // 选「以上都不是」并填了文本 → 完整
    expect(isAnswerComplete([NONE_OPTION_LABEL], "我的方案", true)).toBe(true);

    // 纯文本题（无选项）：必须有输入
    expect(isAnswerComplete([], "", false)).toBe(false);
    expect(isAnswerComplete([], "好的", false)).toBe(true);
  });
});

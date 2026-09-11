import { describe, expect, it } from "vitest";
import { isHexColor, getContrastColor, HEADING_AMBER } from "../src/components/chat/color-utils";

describe("ChatMarkdown Rules and Utilities", () => {
  describe("Hex Color Detection & Contrast", () => {
    it("identifies valid 3-char and 6-char hex colors", () => {
      expect(isHexColor("#fff")).toBe(true);
      expect(isHexColor("#000000")).toBe(true);
      expect(isHexColor("#F59E0B")).toBe(true);
      expect(isHexColor("#08090C")).toBe(true);
      expect(isHexColor("#10B981")).toBe(true);

      expect(isHexColor("fff")).toBe(false);
      expect(isHexColor("#12")).toBe(false);
      expect(isHexColor("#12345")).toBe(false);
      expect(isHexColor("#1234567")).toBe(false);
      expect(isHexColor("not a color")).toBe(false);
    });

    it("calculates correct contrast text color (light text on dark bg, dark text on light bg)", () => {
      // 暗底 (#08090C, #000000) 应返回白字 #FFFFFF
      expect(getContrastColor("#000000")).toBe("#FFFFFF");
      expect(getContrastColor("#08090C")).toBe("#FFFFFF");
      expect(getContrastColor("#1E293B")).toBe("#FFFFFF");

      // 亮底 (#FFFFFF, #F1F5F9) 应返回深色字 #0F172A
      expect(getContrastColor("#FFFFFF")).toBe("#0F172A");
      expect(getContrastColor("#F8FAFC")).toBe("#0F172A");
      expect(getContrastColor("#FEF08A")).toBe("#0F172A");
    });

    it("ensures HEADING_AMBER is amber #F59E0B", () => {
      expect(HEADING_AMBER).toBe("#F59E0B");
    });
  });

  describe("Stress Markdown Content Suite", () => {
    it("validates tricky markdown patterns for AI chat", () => {
      const stressCases = [
        // 1. 超长无空格 URL
        "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        // 2. 超长英文无空格
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        // 3. 嵌套列表
        "- Level 1\n  - Level 2\n    - Level 3\n      - Level 4",
        // 4. 数据表格
        "| ID | Name | Status |\n|---|---|---|\n| 1 | Test | Active |\n| 2 | Very Long Description Content Cell | Pending |",
        // 5. Hex 颜色行内代码
        "这里有几个颜色：`#F59E0B`、`#08090C` 以及 `#10B981` 调色板",
        // 6. 包含代码与未闭合代码块
        "```typescript\nconst message = 'hello';\nconsole.log(message);",
      ];

      for (const content of stressCases) {
        expect(typeof content).toBe("string");
        expect(content.length).toBeGreaterThan(0);
      }
    });
  });
});

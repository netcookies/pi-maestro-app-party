import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/markdown-parser";

describe("parseInline", () => {
  it("parses bold text", () => {
    const parts = parseInline("需要**冷却锁**保护");
    expect(parts).toEqual([
      { text: "需要" },
      { text: "冷却锁", bold: true },
      { text: "保护" },
    ]);
  });

  it("parses inline code", () => {
    const parts = parseInline("`onScroll` 里 `y<40` 触发");
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual(["onScroll", "y<40"]);
  });

  it("parses links", () => {
    const parts = parseInline("看[这里](https://x.com)即可");
    expect(parts.filter((p) => p.link).map((p) => p.text)).toEqual(["这里"]);
  });

  it("parses italic", () => {
    const parts = parseInline("这是*斜体*文字");
    expect(parts.filter((p) => p.italic).map((p) => p.text)).toEqual(["斜体"]);
  });
});

describe("parseBlocks", () => {
  it("parses the problematic message correctly", () => {
    const text = `两个问题都明确：
1. **连触发 3 次"加载更早"**：\`onScroll\` 里 \`y<40\` 触发后，prepend 完成 \`scrollToOffset\` 恢复又触发 scroll 事件，\`loadingMore\` 刚置 false，\`hasMore\` 还 true → 立刻再触发。需要**冷却锁**。
2. **FAB 一键到底**：新增悬浮按钮。

先实现冷却锁 + FAB：`;
    const blocks = parseBlocks(text);
    // 期望: 段落 + 有序列表(2行) + 段落
    expect(blocks.length).toBe(3);
    expect(blocks[0].kind).toBe("paragraph");
    expect(blocks[1].kind).toBe("list");
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].lines).toHaveLength(2);
    expect(blocks[2].kind).toBe("paragraph");
  });

  it("parses headings and code fence", () => {
    const text = "# 标题\n## 子标题\n```\nconst x = 1;\n```\n正文";
    const blocks = parseBlocks(text);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "标题" });
    expect(blocks[1]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[2]).toMatchObject({ kind: "code", lines: ["const x = 1;"] });
    expect(blocks[3]).toMatchObject({ kind: "paragraph", text: "正文" });
  });

  it("parses bullet list and quote and hr", () => {
    const blocks = parseBlocks("> 引用内容\n- 项目A\n- 项目B\n---\n结尾");
    expect(blocks[0]).toMatchObject({ kind: "quote", text: "引用内容" });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: false, lines: ["项目A", "项目B"] });
    expect(blocks[2].kind).toBe("hr");
    expect(blocks[3]).toMatchObject({ kind: "paragraph", text: "结尾" });
  });

  it("handles empty and weird input", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("```未闭合")).toEqual([]);
    expect(parseBlocks("只有一行")).toMatchObject([{ kind: "paragraph", text: "只有一行" }]);
  });
});
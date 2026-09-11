export interface InlinePart {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** 解析行内格式（加粗/斜体/行内代码/链接，及其嵌套） */
export function parseInline(raw: string): InlinePart[] {
  const parts: InlinePart[] = [];
  // 综合正则匹配行内元素：
  // 1. 加粗嵌套代码: **`code`**
  // 2. 加粗普通文本: **bold**
  // 3. 行内代码: `code`
  // 4. 链接: [text](url)
  // 5. 斜体: *italic*
  const pattern = /(\*\*`([^`]+)`\*\*)|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    if (m.index > last) {
      parts.push({ text: raw.slice(last, m.index) });
    }
    if (m[1]) {
      // **`code`**
      parts.push({ text: m[2], bold: true, code: true });
    } else if (m[3]) {
      // **bold**
      parts.push({ text: m[4], bold: true });
    } else if (m[5]) {
      // `code`
      parts.push({ text: m[6], code: true });
    } else if (m[7]) {
      // [text](url)
      parts.push({ text: m[8], link: m[9] });
    } else if (m[10]) {
      // *italic*
      parts.push({ text: m[11], italic: true });
    }
    last = pattern.lastIndex;
  }
  if (last < raw.length) {
    parts.push({ text: raw.slice(last) });
  }
  return parts;
}

/** 解析 block 结构，返回行级元素 */
export interface Block {
  kind: "heading" | "code" | "quote" | "list" | "hr" | "paragraph";
  level?: number;
  text?: string;
  lines?: string[];
  ordered?: boolean;
}

export function parseBlocks(text: string): Block[] {
  const rawLines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // 代码块 ``` ... ```
    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      let closed = false;
      i++;
      while (i < rawLines.length) {
        if (rawLines[i].trim().startsWith("```")) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(rawLines[i]);
        i++;
      }
      if (closed) blocks.push({ kind: "code", lines: codeLines });
      else {
        // 未闭合：把已收集行还原为段落
        for (const l of codeLines) {
          blocks.push({ kind: "paragraph", text: l });
        }
      }
      continue;
    }

    // 标题
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // 引用
    if (trimmed.startsWith(">")) {
      blocks.push({ kind: "quote", text: trimmed.replace(/^>\s?/, "") });
      i++;
      continue;
    }

    // 有序/无序列表（连续行合并）
    const orderedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const listLines: string[] = [];
      while (i < rawLines.length) {
        const l = rawLines[i].trim();
        const om = l.match(/^(\d+)[.)]\s+(.+)$/);
        const bm = l.match(/^[-*]\s+(.+)$/);
        if (ordered && om) {
          listLines.push(om[2]);
          i++;
        } else if (!ordered && bm) {
          listLines.push(bm[1]);
          i++;
        } else break;
      }
      blocks.push({ kind: "list", lines: listLines, ordered });
      continue;
    }

    // 普通段落（合并连续非空行直到遇到 block 语法）
    const paraLines: string[] = [];
    while (i < rawLines.length) {
      const l = rawLines[i].trim();
      if (!l) break;
      if (/^(#{1,4})\s/.test(l)) break;
      if (l.startsWith("```")) break;
      if (/^(\d+)[.)]\s+/.test(l) || /^[-*]\s+/.test(l)) break;
      if (l.startsWith(">")) break;
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: "paragraph", text: paraLines.join("\n") });
      continue;
    }
    i++;
  }
  return blocks;
}


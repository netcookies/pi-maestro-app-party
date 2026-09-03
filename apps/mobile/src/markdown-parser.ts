export interface InlinePart {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** 解析行内格式（加粗/斜体/行内代码/链接） */
export function parseInline(raw: string): InlinePart[] {
  const parts: InlinePart[] = [];
  // 行内代码优先（`...` 不参与其他解析）
  const codeRe = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const segments: { start: number; end: number; code: boolean }[] = [];
  while ((m = codeRe.exec(raw)) !== null) {
    if (m.index > last) segments.push({ start: last, end: m.index, code: false });
    segments.push({ start: m.index, end: m.index + m[0].length, code: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) segments.push({ start: last, end: raw.length, code: false });
  if (segments.length === 0) segments.push({ start: 0, end: raw.length, code: false });

  for (const seg of segments) {
    const slice = raw.slice(seg.start, seg.end);
    if (seg.code) {
      parts.push({ text: slice.slice(1, -1), code: true });
      continue;
    }
    // 链接 [text](url)
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let ll = 0;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(slice)) !== null) {
      if (lm.index > ll) pushStyled(slice.slice(ll, lm.index), parts);
      parts.push({ text: lm[1], link: lm[2] });
      ll = lm.index + lm[0].length;
    }
    if (ll < slice.length) pushStyled(slice.slice(ll), parts);
  }
  return parts;
}

/** 处理加粗 **x** 和斜体 *x* */
function pushStyled(text: string, out: InlinePart[]): void {
  const boldRe = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > last) pushItalic(text.slice(last, m.index), out, false);
    pushItalic(m[1], out, true);
    last = m.index + m[0].length;
  }
  if (last < text.length) pushItalic(text.slice(last), out, false);
}

function pushItalic(text: string, out: InlinePart[], bold: boolean): void {
  const italicRe = /\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = italicRe.exec(text)) !== null) {
    if (m.index > last) {
      const plain = text.slice(last, m.index);
      if (plain.trim()) {
        if (bold) out.push({ text: plain, bold });
        else out.push({ text: plain });
      }
    }
    out.push({ text: m[1], italic: true, ...(bold ? { bold } : {}) });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const rest = text.slice(last);
    if (rest.trim()) {
      if (bold) out.push({ text: rest, bold });
      else out.push({ text: rest });
    }
  }
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
          listLines.push(om[1]);
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


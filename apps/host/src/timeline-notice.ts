/**
 * 跨会话/系统通告消息分类器（满足 spec:coding-conventions-002 单一映射函数）
 *
 * 历史原因：jsonl-pager 与 jsonl-tail-watcher 过去把 custom_message 全部硬编码为 kind:"user"，
 * 导致来自 peer、teammate、后台任务、循环等的系统通告全部被渲染为用户紫色气泡。
 * 本函数作为唯一权威，把 custom_message 正确分类为 notice，未知类型保守保持 user。
 */
export type CustomMessageClassification =
  | { kind: "notice"; noticeKind: string; text: string }
  | { kind: "user"; text: string };

const NOTICE_KIND_MAP: Record<string, string> = {
  // peer 跨 cwd 协作
  "mb-peer": "peer",

  // teammate 子代理生命周期
  "teammate-message": "teammate",
  "teammate-started": "teammate",
  "teammate-complete": "teammate",

  // 后台任务
  "bash-bg-running": "background",
  "bash-bg-complete": "background",
  "ssh-bg-complete": "background",
  "ssh-gateway-complete": "background",

  // 循环状态
  "loop-event": "loop",
  "loop-active": "loop",
  "loop-tick": "loop",

  // 系统/MCP/评审
  "mcp-ui-intent": "system",
  "mcp-ui-prompt": "system",
  "codex-hook-context": "system",
  "codex-hook-failure": "system",
  "knowledge-closeout-request": "system",
};

/** 从 content 字段提取纯文本；兼顾字符串与 TextContent 数组 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => {
        if (typeof block === "string") return [block];
        if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
          return [(block as { text: string }).text];
        }
        return [];
      })
      .join("\n");
  }
  return "";
}

/** 剥离 peer 消息开头的重复方向前缀（例如 `← 来自 peer abc\n\n正文`） */
function stripPeerPrefix(text: string): string {
  return text.replace(/^(?:←|→)\s*(?:来自|发给)\s+peer\s+[a-f0-9-]+\s*\n*/u, "").trim();
}

/** 兼容历史遗留的 `\n---\n` 切分（仅当首行带 [workspace:message] 标记时生效） */
function splitLegacyMarker(text: string): string {
  if (text.startsWith("[workspace:message]")) {
    const cut = text.indexOf("\n---\n");
    if (cut >= 0) return text.slice(cut + 5).trim();
  }
  return text;
}

const MAX_NOTICE_CHARS = 2000;

export function classifyCustomMessage(entry: Record<string, unknown>): CustomMessageClassification | null {
  const customType = typeof entry.customType === "string" ? entry.customType : "";
  let rawText = extractContentText(entry.content);

  // mb-peer 优先取 details.body
  if (customType === "mb-peer") {
    const details = typeof entry.details === "object" && entry.details !== null ? entry.details as Record<string, unknown> : undefined;
    if (typeof details?.body === "string" && details.body.trim().length > 0) {
      rawText = details.body;
    }
  }

  const text = splitLegacyMarker(stripPeerPrefix(rawText)).slice(0, MAX_NOTICE_CHARS).trim();
  if (!text) return null;

  const noticeKind = NOTICE_KIND_MAP[customType];
  if (noticeKind) {
    return { kind: "notice", noticeKind, text };
  }

  // 保守兜底：未知 customType 保留 user，避免不可逆把历史用户输入降级为系统通告
  return { kind: "user", text };
}

/**
 * jsonl-replay — 从 Pi 会话 jsonl 文件直接解析历史消息（只读）
 *
 * 为什么需要：SDK 的 session.messages 只保留 LLM 上下文内的消息，
 * tool 输出（bash 表格/截图路径）和早期消息会被裁剪。
 * 直接解析 jsonl 文件可拿到完整历史，包括：
 *  - toolResult（bash 输出、图片路径）
 *  - user 粘贴的图片路径
 *  - thinking、assistant、toolCall
 */
import { readFile } from "node:fs/promises";
import type { TimelineItem } from "@maestro-mobile/shared";

export interface JsonlReplayResult {
  items: TimelineItem[];
  /** 解析的原始消息条数 */
  totalEntries: number;
}

/** 从 jsonl 文件解析完整 timeline（按文件顺序） */
export async function replayFromJsonl(filePath: string): Promise<JsonlReplayResult> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return { items: [], totalEntries: 0 };
  }

  const items: TimelineItem[] = [];
  const seenToolResults = new Set<string>();
  let totalEntries = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    totalEntries++;

    const msg = (entry.message ?? {}) as Record<string, unknown>;
    const role = String(msg.role ?? "");
    const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : 0;
    const createdAt = timestamp > 0 ? new Date(timestamp).toISOString() : "";

    if (role === "toolResult") {
      const toolCallId = String(msg.toolCallId ?? "");
      if (toolCallId && seenToolResults.has(toolCallId)) continue;
      if (toolCallId) seenToolResults.add(toolCallId);
      const toolName = String(msg.toolName ?? "tool");
      const text = extractText(msg.content);
      if (!text) continue;
      items.push({
        id: `replay-tool-${items.length}`,
        kind: "tool",
        text,
        createdAt,
        toolName,
        toolCallId,
        isError: msg.isError === true,
      });
      continue;
    }

    if (role === "tool" || role === "toolCall") {
      const toolName = String(msg.toolName ?? "tool");
      const text = extractText(msg.content);
      items.push({
        id: `replay-toolcall-${items.length}`,
        kind: "tool",
        text: text || `调用 ${toolName}`,
        createdAt,
        toolName,
      });
      continue;
    }

    const text = extractText(msg.content);
    if (role === "user") {
      items.push({ id: `replay-user-${items.length}`, kind: "user", text, createdAt });
    } else if (role === "assistant" || role === "system") {
      if (!text) continue;
      items.push({ id: `replay-assistant-${items.length}`, kind: "assistant", text, createdAt });
    } else if (role === "thinking") {
      if (!text) continue;
      items.push({ id: `replay-thinking-${items.length}`, kind: "thinking", text, createdAt });
    }
    // toolResult 已在上面处理；其余角色忽略
  }

  return { items, totalEntries };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}
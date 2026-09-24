import type { TimelineItem } from "@maestro-mobile/shared";

export type TimelineRow =
  | { type: "item"; item: TimelineItem }
  | { type: "tool_group"; id: string; items: TimelineItem[]; invocationCount: number; status: "running" | "failed" | "completed" | "pending" };

const INTERACTIVE_TOOL_NAMES = new Set(["ask-user-question", "plan", "plan_update", "plan_confirm"]);

function isInteractive(item: TimelineItem): boolean {
  const name = item.toolName?.toLowerCase();
  return !!name && (INTERACTIVE_TOOL_NAMES.has(name) || name.includes("ask") || name.includes("question") || name.includes("confirm") || name.includes("plan"));
}

function isCompletedResult(item: TimelineItem): boolean {
  return item.id.startsWith("live-tool-") || (item.id.startsWith("replay-tool-") && !item.id.startsWith("replay-toolcall-") && !item.id.startsWith("replay-ask-"));
}

export function toolInvocationCount(items: readonly TimelineItem[]): number {
  const callIds = new Set(items.map((item) => item.toolCallId).filter((id): id is string => !!id));
  const withoutCallId = items.filter((item) => !item.toolCallId).length;
  return callIds.size + withoutCallId;
}

function toolStatus(items: TimelineItem[]): "running" | "failed" | "completed" | "pending" {
  const completedCallIds = new Set(items
    .filter((item) => isCompletedResult(item) && item.toolCallId)
    .map((item) => item.toolCallId as string));
  if (items.some((item) => item.status === "running"
    || ((item.id.startsWith("live-toolcall-") || item.id.startsWith("replay-toolcall-"))
      && item.toolCallId !== undefined && !completedCallIds.has(item.toolCallId)))) return "running";
  if (items.some((item) => item.status === "failed" || item.isError || item.error)) return "failed";
  if (items.every((item) => item.status === "completed" || isCompletedResult(item)
    || (item.toolCallId !== undefined && completedCallIds.has(item.toolCallId)))) return "completed";
  return "pending";
}

function canGroup(item: TimelineItem): boolean {
  return item.kind === "tool" && !item.error && !isInteractive(item);
}

export function buildTimelineRows(items: readonly TimelineItem[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let group: TimelineItem[] = [];
  const flush = () => {
    if (group.length === 0) return;
    if (group.length === 1) rows.push({ type: "item", item: group[0]! });
    else rows.push({
      type: "tool_group",
      id: group[0]!.id,
      items: group,
      invocationCount: toolInvocationCount(group),
      status: toolStatus(group),
    });
    group = [];
  };

  for (const item of items) {
    if (canGroup(item)) {
      group.push(item);
    } else {
      flush();
      rows.push({ type: "item", item });
    }
  }
  flush();
  return rows;
}

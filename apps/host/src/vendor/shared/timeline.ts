import type { TimelineItem, HostEvent } from "./protocol.js";

export interface TimelineProjectionState {
  lastSeq: number;
}

export function createTimelineProjectionState(): TimelineProjectionState {
  return { lastSeq: 0 };
}

/**
 * 将 Pi SDK 原始事件投影为 TimelineItem
 * 这是一个纯函数，不依赖 SDK 类型，只处理投影过的结构化事件
 */
export function projectEventToTimeline(
  state: TimelineProjectionState,
  event: HostEvent,
): TimelineItem[] {
  if (event.type === "timeline_item") {
    return [event.item];
  }
  return [];
}

/**
 * 从 SessionState 的 messageCount 反推是否需要补充 user 消息
 */
export function isUserMessage(message: string, items: TimelineItem[]): boolean {
  return message.trim().length > 0
    && items.every((item) => item.text !== message);
}
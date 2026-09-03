import type { HostEvent } from "@maestro-mobile/shared";

/** 分布式 Omit：对联合类型的每个成员分别 Omit（TS 默认 Omit 不是分布式的） */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * EventLog — 事件日志（顺序序列号 + 持久化支持）
 * 用于断线重连后的增量同步
 */
export class EventLog {
  private readonly events: HostEvent[] = [];
  private nextSeq = 1;
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  get nextSequence(): number {
    return this.nextSeq;
  }

  record(event: DistributiveOmit<HostEvent, "seq">): HostEvent {
    const seq = this.nextSeq++;
    const full: HostEvent = { ...event, seq } as HostEvent;
    this.events.push(full);
    if (this.events.length > this.maxEntries) {
      this.events.splice(0, this.events.length - this.maxEntries);
    }
    return full;
  }

  eventsSince(seq: number): HostEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  get all(): HostEvent[] {
    return [...this.events];
  }
}
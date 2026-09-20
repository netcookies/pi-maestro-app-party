import type { HostEvent } from "@maestro-mobile/shared";

/** 分布式 Omit：对联合类型的每个成员分别 Omit（TS 默认 Omit 不是分布式的） */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * EventLog — 事件日志（顺序序列号 + 持久化支持）
 * 用于断线重连后的增量同步
 */
export class EventLog {
  private readonly events: Array<{ value: HostEvent; bytes: number }> = [];
  private retainedBytes = 0;
  private nextSeq = 1;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries = 10_000, maxBytes = 16 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get nextSequence(): number {
    return this.nextSeq;
  }

  record(event: DistributiveOmit<HostEvent, "seq">): HostEvent {
    const seq = this.nextSeq++;
    const full: HostEvent = { ...event, seq } as HostEvent;
    const bytes = Buffer.byteLength(JSON.stringify(full), "utf8");
    if (bytes <= this.maxBytes) {
      this.events.push({ value: full, bytes });
      this.retainedBytes += bytes;
      while (this.events.length > this.maxEntries || this.retainedBytes > this.maxBytes) {
        const removed = this.events.shift();
        if (!removed) break;
        this.retainedBytes -= removed.bytes;
      }
    }
    return full;
  }

  eventsSince(seq: number): HostEvent[] {
    return this.events.filter((entry) => entry.value.seq > seq).map((entry) => entry.value);
  }

  get all(): HostEvent[] {
    return this.events.map((entry) => entry.value);
  }
}
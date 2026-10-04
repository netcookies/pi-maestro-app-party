import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
  NOTIFICATION_MAX_OUTBOX_ENTRIES,
  NOTIFICATION_MAX_ATTEMPTS,
  type NotificationEvent,
  type NotificationOutboxEntry,
  type DeliveryResult,
  normalizeNotificationEvent,
} from "./notification-types.js";

interface PersistedOutbox {
  schemaVersion: 1;
  entries: NotificationOutboxEntry[];
}

export class NotificationOutbox {
  private entries = new Map<string, NotificationOutboxEntry>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedOutbox>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries) {
        if (!entry?.event?.eventId || !entry.event.dedupeKey) continue;
        if (entry.status === "sending") entry.status = "pending";
        this.entries.set(entry.event.eventId, entry);
      }
      this.trim();
    } catch {
      // Missing or malformed state is treated as an empty queue.
    }
  }

  async enqueue(event: NotificationEvent): Promise<boolean> {
    await this.load();
    const normalized = normalizeNotificationEvent(event);
    if ([...this.entries.values()].some((entry) => entry.event.dedupeKey === normalized.dedupeKey && entry.status !== "expired")) return false;
    const now = this.now();
    this.entries.set(normalized.eventId, {
      event: normalized,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    this.trim();
    await this.persist();
    return true;
  }

  async claimReady(limit = 32): Promise<NotificationOutboxEntry[]> {
    await this.load();
    const now = this.now();
    const ready = [...this.entries.values()]
      .filter((entry) => entry.status === "pending" && entry.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    for (const entry of ready) {
      entry.status = "sending";
      entry.updatedAt = now;
    }
    try {
      if (ready.length > 0) await this.persist();
    } catch (error) {
      for (const entry of ready) entry.status = "pending";
      throw error;
    }
    return ready.map((entry) => structuredClone(entry));
  }

  async settle(eventId: string, result: DeliveryResult): Promise<void> {
    await this.load();
    const entry = this.entries.get(eventId);
    if (!entry) return;
    const previous = structuredClone(entry);
    const now = this.now();
    entry.attempts += 1;
    entry.updatedAt = now;
    entry.lastErrorCode = result.ok ? undefined : result.code.slice(0, 120);
    if (result.ok) {
      entry.status = "sent";
    } else if (!result.retryable || entry.attempts >= NOTIFICATION_MAX_ATTEMPTS) {
      entry.status = "failed";
    } else {
      entry.status = "pending";
      entry.nextAttemptAt = now + Math.min(60 * 60_000, 1000 * 2 ** Math.min(10, entry.attempts));
    }
    try {
      await this.persist();
    } catch (error) {
      this.entries.set(eventId, previous);
      throw error;
    }
  }

  async recordProviderResult(eventId: string, providerId: string, result: DeliveryResult): Promise<void> {
    await this.load();
    const entry = this.entries.get(eventId);
    if (!entry) return;
    entry.providerResults = { ...(entry.providerResults ?? {}), [providerId]: result };
    entry.updatedAt = this.now();
    await this.persist();
  }
  async expire(eventId: string): Promise<void> {
    await this.load();
    const entry = this.entries.get(eventId);
    if (!entry) return;
    entry.status = "expired";
    entry.updatedAt = this.now();
    await this.persist();
  }

  async release(eventId: string): Promise<void> {
    await this.load();
    const entry = this.entries.get(eventId);
    if (!entry || entry.status !== "sending") return;
    entry.status = "pending";
    entry.nextAttemptAt = this.now();
    entry.updatedAt = this.now();
    await this.persist();
  }

  async list(): Promise<NotificationOutboxEntry[]> {
    await this.load();
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  private trim(): void {
    if (this.entries.size <= NOTIFICATION_MAX_OUTBOX_ENTRIES) return;
    const removable = [...this.entries.values()]
      .filter((entry) => entry.status === "sent" || entry.status === "failed")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.entries.size > NOTIFICATION_MAX_OUTBOX_ENTRIES && removable.length > 0) {
      this.entries.delete(removable.shift()!.event.eventId);
    }
    while (this.entries.size > NOTIFICATION_MAX_OUTBOX_ENTRIES) {
      const first = this.entries.keys().next().value as string | undefined;
      if (!first) break;
      this.entries.delete(first);
    }
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedOutbox = { schemaVersion: 1, entries: structuredClone([...this.entries.values()]) };
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(tempPath, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    await this.writeChain;
  }
}

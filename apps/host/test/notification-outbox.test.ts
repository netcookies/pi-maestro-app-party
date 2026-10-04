import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationOutbox } from "../src/notifications/notification-outbox.js";
import type { NotificationEvent } from "../src/notifications/notification-types.js";

const event = (index = 1): NotificationEvent => ({
  eventId: `event-${index}`,
  kind: "ask_pending",
  sessionId: "session-1",
  title: "确认",
  body: "请确认操作",
  occurredAt: new Date(0).toISOString(),
  dedupeKey: `ask-${index}`,
  priority: "high",
});

describe("NotificationOutbox", () => {
  it("deduplicates events and recovers persisted entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maestro-notification-"));
    const path = join(directory, "outbox.json");
    let now = 100;
    const first = new NotificationOutbox(path, () => now);
    expect(await first.enqueue(event())).toBe(true);
    expect(await first.enqueue({ ...event(), eventId: "event-duplicate", dedupeKey: "ask-1" })).toBe(false);

    const second = new NotificationOutbox(path, () => now);
    const ready = await second.claimReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.event.eventId).toBe("event-1");
  });

  it("retries transient failures and permanently fails non-retryable ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maestro-notification-"));
    let now = 100;
    const outbox = new NotificationOutbox(join(directory, "outbox.json"), () => now);
    await outbox.enqueue(event());
    const claimed = await outbox.claimReady();
    expect(claimed).toHaveLength(1);
    await outbox.settle("event-1", { ok: false, retryable: true, code: "timeout" });
    expect((await outbox.list())[0]?.status).toBe("pending");
    now += 2000;
    const retry = await outbox.claimReady();
    expect(retry).toHaveLength(1);
    await outbox.settle("event-1", { ok: false, retryable: false, code: "invalid_config" });
    expect((await outbox.list())[0]?.status).toBe("failed");
  });

  it("bounds event text and persisted queue size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maestro-notification-"));
    const path = join(directory, "outbox.json");
    const outbox = new NotificationOutbox(path, () => 100);
    await outbox.enqueue({ ...event(), title: "x".repeat(500), body: "y".repeat(5000) });
    const stored = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ event: NotificationEvent }> };
    expect(stored.entries[0]?.event.title.length).toBe(160);
    expect(stored.entries[0]?.event.body.length).toBe(4000);
  });
});

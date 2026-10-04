import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationDispatcher } from "../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../src/notifications/notification-outbox.js";
import { NotificationConfigStore } from "../src/notifications/notification-config.js";
import type { NotificationEvent, NotificationProvider } from "../src/notifications/notification-types.js";
import { defaultProviderSettings } from "../src/notification-tui.js";

const event = (patch: Partial<NotificationEvent> = {}): NotificationEvent => ({
  eventId: "event-1",
  kind: "agent_settled",
  sessionId: "session-1",
  title: "Done",
  body: "Finished",
  occurredAt: new Date(0).toISOString(),
  dedupeKey: "event-1",
  priority: "normal",
  ...patch,
});

const provider: NotificationProvider = {
  kind: "webhook",
  validate: (config) => config as never,
  send: vi.fn(async () => ({ ok: true, retryable: false, code: "sent" })),
  test: vi.fn(async () => ({ ok: true, retryable: false, code: "sent" })),
};

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "maestro-notification-dispatcher-"));
  const outbox = new NotificationOutbox(join(directory, "outbox.json"));
  const config = new NotificationConfigStore(join(directory, "config.json"));
  await config.write({ schemaVersion: 1, providers: [{ id: "webhook", kind: "webhook", name: "Webhook", enabled: true, eventKinds: ["agent_settled"], settings: { url: "https://example.test" } }] });
  return { outbox, config, dispatcher: new NotificationDispatcher(outbox, config, new Map([["webhook", provider]])) };
}

describe("NotificationDispatcher", () => {
  it("expires plan notifications whose deadline passed before dispatch", async () => {
    const { outbox, dispatcher } = await setup();
    await outbox.enqueue(event({ kind: "plan_confirm_pending", deadlineAt: 1 }));
    await dispatcher.dispatchOnce();
    expect((await outbox.list())[0]?.status).toBe("expired");
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("releases a claimed entry when persistence fails during delivery", async () => {
    const { outbox, dispatcher } = await setup();
    await outbox.enqueue(event());
    const recordProviderResult = vi.spyOn(outbox, "recordProviderResult").mockRejectedValueOnce(new Error("disk full"));
    await dispatcher.dispatchOnce();
    expect(recordProviderResult).toHaveBeenCalled();
    expect((await outbox.list())[0]?.status).toBe("pending");
  });

  it("does not reschedule after stop races with a timer callback", async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher } = await setup();
      dispatcher.start();
      dispatcher.stop();
      await vi.runAllTimersAsync();
      dispatcher.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("provides the displayed default servers for ntfy and bark forms", () => {
    expect(defaultProviderSettings("ntfy")).toEqual({ server: "https://ntfy.sh" });
    expect(defaultProviderSettings("bark")).toEqual({ server: "https://api.day.app" });
    expect(defaultProviderSettings("pushdeer")).toEqual({});
  });
});

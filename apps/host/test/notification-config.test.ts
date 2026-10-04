import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationConfigStore } from "../src/notifications/notification-config.js";
import type { NotificationProviderConfig } from "../src/notifications/notification-types.js";

const provider = (overrides: Partial<NotificationProviderConfig> = {}): NotificationProviderConfig => ({
  id: "ntfy-main", kind: "ntfy", name: "ntfy", enabled: true,
  eventKinds: ["ask_pending"], settings: { server: "https://ntfy.sh", topic: "private", token: "secret" }, ...overrides,
});

describe("NotificationConfigStore", () => {
  it("upserts without losing existing provider secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-notification-config-"));
    const store = new NotificationConfigStore(join(dir, "config.json"));
    await store.upsertProvider(provider());
    const next = await store.upsertProvider(provider({ name: "renamed", eventKinds: ["plan_review_pending"] , settings: { topic: "next-topic" } }));
    expect(next.providers[0]).toMatchObject({ name: "renamed", eventKinds: ["plan_review_pending"], settings: { topic: "next-topic", token: "secret", server: "https://ntfy.sh" } });
    expect(JSON.parse(await readFile(join(dir, "config.json"))).providers[0].settings.token).toBe("secret");
  });

  it("updates only event kinds and removes providers atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "maestro-notification-config-"));
    const store = new NotificationConfigStore(join(dir, "config.json"));
    await store.upsertProvider(provider());
    expect((await store.updateEventKinds("ntfy-main", ["plan_confirm_pending"])).providers[0]?.settings.token).toBe("secret");
    expect((await store.removeProvider("ntfy-main")).providers).toHaveLength(0);
  });
});

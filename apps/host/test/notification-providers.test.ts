import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationProviders } from "../src/notifications/providers/index.js";
import { testEvent } from "../src/notifications/providers/helpers.js";
import type { NotificationProviderConfig } from "../src/notifications/notification-types.js";

const base = (kind: NotificationProviderConfig["kind"], settings: Record<string, string>): NotificationProviderConfig => ({ id: kind, kind, name: kind, enabled: true, eventKinds: ["session_error"], settings });

describe("notification providers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  });

  it("registers all supported providers", () => {
    expect([...notificationProviders.keys()]).toEqual(["pushdeer", "ntfy", "bark", "gotify", "telegram", "webhook"]);
  });

  it.each([
    ["pushdeer", { pushkey: "secret" }],
    ["ntfy", { server: "https://ntfy.sh", topic: "topic" }],
    ["bark", { server: "https://api.day.app", deviceKey: "secret" }],
    ["gotify", { server: "https://gotify.example", token: "secret" }],
    ["telegram", { botToken: "secret", chatId: "123" }],
    ["webhook", { url: "https://example.test/hook" }],
  ])("sends %s without exposing credentials", async (kind, settings) => {
    const provider = notificationProviders.get(kind as NotificationProviderConfig["kind"])!;
    const config = provider.validate(base(kind as NotificationProviderConfig["kind"], settings));
    const result = await provider.send(testEvent(), config, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("treats a PushDeer business error as failed even when HTTP status is 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 80501, error: "错误的Key" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const provider = notificationProviders.get("pushdeer")!;
    const result = await provider.send(testEvent(), provider.validate(base("pushdeer", { pushkey: "invalid" })), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, retryable: false, statusCode: 200, code: "provider_80501" });
  });
  it("classifies transient HTTP errors for retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream", { status: 503 })));
    const provider = notificationProviders.get("webhook")!;
    const result = await provider.send(testEvent(), provider.validate(base("webhook", { url: "https://example.test/hook" })), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, retryable: true, code: "http_503" });
  });

  it("rejects unsafe webhook URLs and headers", async () => {
    const provider = notificationProviders.get("webhook")!;
    const config = provider.validate(base("webhook", { url: "http://example.test/hook", headers: "{\"x-api-key\":\"secret\",\"x-forwarded-for\":\"bad\"}" }));
    const result = await provider.send(testEvent(), config, new AbortController().signal);
    expect(result.ok).toBe(true);
    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect((request.headers as Record<string, string>)["x-forwarded-for"]).toBeUndefined();
  });
});

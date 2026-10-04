import {
  type DeliveryResult,
  type NotificationEvent,
  type NotificationProvider,
  type NotificationProviderConfig,
} from "./notification-types.js";
import { NotificationOutbox } from "./notification-outbox.js";
import { NotificationConfigStore } from "./notification-config.js";

export class NotificationDispatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly configStore: NotificationConfigStore,
    private readonly providers: Map<string, NotificationProvider>,
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(event: NotificationEvent): Promise<boolean> {
    const added = await this.outbox.enqueue(event);
    if (added) this.schedule(0);
    return added;
  }

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async dispatchOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const config = await this.configStore.read();
      const entries = await this.outbox.claimReady();
      for (const entry of entries) {
        const configured = config.providers.filter((provider) => provider.enabled && provider.eventKinds.includes(entry.event.kind));
        if (configured.length === 0) {
          await this.outbox.settle(entry.event.eventId, { ok: true, retryable: false, code: "no_provider_configured" });
          continue;
        }
        let failed: DeliveryResult | undefined;
        for (const providerConfig of configured) {
          if (entry.providerResults?.[providerConfig.id]?.ok) continue;
          const provider = this.providers.get(providerConfig.kind);
          if (!provider) {
            failed = { ok: false, retryable: false, code: "unsupported_provider" };
            continue;
          }
          const result = await this.send(provider, providerConfig, entry.event);
          await this.outbox.recordProviderResult(entry.event.eventId, providerConfig.id, result);
          if (!result.ok) failed = result;
        }
        await this.outbox.settle(entry.event.eventId, failed ?? { ok: true, retryable: false, code: "sent" });
      }
      return entries.length;
    } finally {
      this.running = false;
    }
  }

  private async send(provider: NotificationProvider, config: NotificationProviderConfig, event: NotificationEvent): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await provider.send(event, config, controller.signal);
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        code: error instanceof Error && error.name === "AbortError" ? "provider_timeout" : "provider_error",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatchOnce().catch(() => undefined).finally(() => {
        if (this.running) return;
        this.schedule(Math.max(1000, Math.min(30_000, 60_000 - (this.now() % 60_000))));
      });
    }, delayMs);
    this.timer.unref?.();
  }
}

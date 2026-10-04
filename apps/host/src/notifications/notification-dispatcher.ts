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
  private inFlight: Promise<number> | null = null;
  private started = false;
  private lifecycle = 0;
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly configStore: NotificationConfigStore,
    private readonly providers: Map<string, NotificationProvider>,
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(event: NotificationEvent): Promise<boolean> {
    const added = await this.outbox.enqueue(event);
    if (added && this.started) this.schedule(0);
    return added;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lifecycle += 1;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.lifecycle += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.activeControllers) controller.abort();
    await this.inFlight;
  }

  dispatchOnce(): Promise<number> {
    if (this.inFlight) return Promise.resolve(0);
    const lifecycle = this.lifecycle;
    const flight = this.dispatch(lifecycle).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = flight;
    return flight;
  }

  private async dispatch(lifecycle: number): Promise<number> {
    const config = await this.configStore.read();
    if (lifecycle !== this.lifecycle) return 0;
    const entries = await this.outbox.claimReady();
    for (const entry of entries) {
      try {
        if (lifecycle !== this.lifecycle) {
          await this.outbox.release(entry.event.eventId).catch(() => undefined);
          continue;
        }
        if (entry.event.deadlineAt !== undefined && entry.event.deadlineAt <= this.now()) {
          await this.outbox.expire(entry.event.eventId);
          continue;
        }
        const configured = config.providers.filter((provider) => provider.enabled && provider.eventKinds.includes(entry.event.kind));
        if (configured.length === 0) {
          await this.outbox.settle(entry.event.eventId, { ok: true, retryable: false, code: "no_provider_configured" });
          continue;
        }
        let failed: DeliveryResult | undefined;
        for (const providerConfig of configured) {
          if (lifecycle !== this.lifecycle) break;
          if (entry.event.deadlineAt !== undefined && entry.event.deadlineAt <= this.now()) break;
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
        if (lifecycle !== this.lifecycle) {
          await this.outbox.release(entry.event.eventId).catch(() => undefined);
        } else if (entry.event.deadlineAt !== undefined && entry.event.deadlineAt <= this.now()) {
          await this.outbox.expire(entry.event.eventId);
        } else {
          await this.outbox.settle(entry.event.eventId, failed ?? { ok: true, retryable: false, code: "sent" });
        }
      } catch {
        await this.outbox.release(entry.event.eventId).catch(() => undefined);
      }
    }
    return entries.length;
  }

  private async send(provider: NotificationProvider, config: NotificationProviderConfig, event: NotificationEvent): Promise<DeliveryResult> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
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
      this.activeControllers.delete(controller);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer || !this.started) return;
    const lifecycle = this.lifecycle;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.started || lifecycle !== this.lifecycle) return;
      void this.dispatchOnce().catch(() => undefined).finally(() => {
        if (!this.started || lifecycle !== this.lifecycle) return;
        this.schedule(Math.max(1000, Math.min(30_000, 60_000 - (this.now() % 60_000))));
      });
    }, delayMs);
    this.timer.unref?.();
  }
}

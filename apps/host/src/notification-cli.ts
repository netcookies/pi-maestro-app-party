import { homedir } from "node:os";
import { join } from "node:path";
import { NotificationConfigError, NotificationConfigStore } from "./notifications/notification-config.js";
import { isNotificationKind, isNotificationProviderKind, type NotificationKind, type NotificationProviderConfig, type NotificationProviderKind } from "./notifications/notification-types.js";
import { notificationProviders } from "./notifications/providers/index.js";

export const NOTIFICATION_CONFIG_PATH = join(homedir(), ".pi", "maestro-mobile-notifications.json");
export const DEFAULT_NOTIFICATION_KINDS: NotificationKind[] = ["ask_pending", "plan_pending", "plan_review_pending", "plan_confirm_pending", "agent_settled", "session_error"];

function store(): NotificationConfigStore {
  return new NotificationConfigStore(NOTIFICATION_CONFIG_PATH);
}

function redacted(provider: NotificationProviderConfig) {
  return { id: provider.id, kind: provider.kind, name: provider.name, enabled: provider.enabled, eventKinds: provider.eventKinds, configured: Object.keys(provider.settings).length > 0 };
}

function parseSettings(argv: string[], start: number): Record<string, string> {
  const settings: Record<string, string> = {};
  for (let index = start; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!key || !value || !argv[index]?.startsWith("--")) throw new Error("Usage: --key value");
    settings[key] = value;
  }
  return settings;
}

export async function runNotifyCommand(argv: string[], _port?: number, _token?: string): Promise<boolean> {
  if (argv[0] !== "notify") return false;
  const action = argv[1] ?? "list";
  const configStore = store();
  if (action === "list") {
    const config = await configStore.read();
    console.log(JSON.stringify(config.providers.map(redacted), null, 2));
    return true;
  }
  if (action === "test") {
    const config = await configStore.read();
    const selected = argv[2] ? config.providers.filter((provider) => provider.id === argv[2]) : config.providers;
    const results = [];
    for (const providerConfig of selected) {
      const provider = notificationProviders.get(providerConfig.kind);
      if (!provider) { results.push({ providerId: providerConfig.id, ok: false, code: "unsupported_provider" }); continue; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const result = await provider.test(providerConfig, controller.signal);
        results.push({ providerId: providerConfig.id, ok: result.ok, code: result.code });
      } catch {
        results.push({ providerId: providerConfig.id, ok: false, code: "provider_error" });
      } finally { clearTimeout(timer); }
    }
    console.log(JSON.stringify({ ok: results.length > 0 && results.every((result) => result.ok), results }, null, 2));
    return true;
  }
  if (action === "add") {
    const kind = argv[2] as NotificationProviderKind | undefined;
    const id = argv[3];
    const name = argv[4] ?? id;
    if (!kind || !isNotificationProviderKind(kind) || !id || !name) throw new Error("Usage: maestro-mobile notify add <provider> <id> [name] --key value ...");
    const provider: NotificationProviderConfig = { id, kind, name, enabled: true, eventKinds: [...DEFAULT_NOTIFICATION_KINDS], settings: parseSettings(argv, 5) };
    const config = await configStore.upsertProvider(provider);
    console.log(JSON.stringify(config.providers.map(redacted), null, 2));
    return true;
  }
  if (action === "update") {
    const id = argv[2];
    if (!id) throw new Error("Usage: maestro-mobile notify update <id> --events kind,kind");
    const eventsArg = argv.find((arg) => arg.startsWith("--events="))?.slice("--events=".length) ?? (() => { const index = argv.indexOf("--events"); return index >= 0 ? argv[index + 1] : undefined; })();
    if (!eventsArg) throw new Error("Usage: maestro-mobile notify update <id> --events kind,kind");
    const events = eventsArg.split(",").filter(Boolean);
    if (!events.every(isNotificationKind)) throw new NotificationConfigError("invalid notification event kind");
    const config = await configStore.updateEventKinds(id, events);
    console.log(JSON.stringify(config.providers.map(redacted), null, 2));
    return true;
  }
  if (action === "remove") {
    const id = argv[2];
    if (!id) throw new Error("Usage: maestro-mobile notify remove <id>");
    const config = await configStore.removeProvider(id);
    console.log(JSON.stringify(config.providers.map(redacted), null, 2));
    return true;
  }
  throw new Error("Usage: maestro-mobile notify list|add|update|test|remove");
}

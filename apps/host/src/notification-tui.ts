import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NotificationConfigStore } from "./notifications/notification-config.js";
import { notificationProviders } from "./notifications/providers/index.js";
import { isNotificationKind, type NotificationKind } from "./notifications/notification-types.js";
import { NOTIFICATION_CONFIG_PATH } from "./notification-cli.js";

export async function runNotificationTui(ctx: ExtensionContext): Promise<void> {
  const ui = ctx.ui as unknown as {
    select?: (message: string, options: string[]) => Promise<string>;
    input?: (message: string) => Promise<string>;
    confirm?: (message: string) => Promise<boolean>;
    notify: (message: string, level: "info" | "warning") => void;
  };
  if (!ui.select) {
    ui.notify("maestro-mobile notify：当前 TUI 不提供安全交互控件，请使用 `maestro-mobile notify ...` CLI；不会在 TUI 中收集 secret", "warning");
    return;
  }
  const store = new NotificationConfigStore(NOTIFICATION_CONFIG_PATH);
  const action = await ui.select("通知管理", ["查看 Provider", "修改通知事件", "测试 Provider", "删除 Provider", "新增 Provider（请用 CLI）", "退出"]);
  if (action === "退出") return;
  const config = await store.read();
  if (action === "查看 Provider") {
    ui.notify(config.providers.length === 0 ? "暂无 Provider" : config.providers.map((provider) => `${provider.id} · ${provider.kind} · ${provider.enabled ? "启用" : "停用"} · events=${provider.eventKinds.join(",")}`).join("\n"), "info");
    return;
  }
  if (config.providers.length === 0) {
    ui.notify("暂无 Provider；新增 Provider 可能需要 secret，请使用本地 CLI：maestro-mobile notify add ...", "warning");
    return;
  }
  const providerId = await ui.select("选择 Provider", config.providers.map((provider) => provider.id));
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (!provider) return;
  if (action === "删除 Provider") {
    if (ui.confirm && !(await ui.confirm(`确认删除 Provider ${provider.id}？`))) return;
    await store.removeProvider(provider.id);
    ui.notify(`已删除 Provider ${provider.id}`, "info");
    return;
  }
  if (action === "修改通知事件") {
    const raw = ui.input ? await ui.input(`事件类型（逗号分隔；当前 ${provider.eventKinds.join(",")}）`) : "";
    const events = raw.split(",").map((value) => value.trim()).filter(Boolean) as NotificationKind[];
    if (!events.length || !events.every(isNotificationKind)) {
      ui.notify("事件类型无效，支持 ask_pending、plan_pending、plan_review_pending、plan_confirm_pending、agent_settled、session_error", "warning");
      return;
    }
    await store.updateEventKinds(provider.id, [...new Set(events)]);
    ui.notify(`已更新 ${provider.id} 的通知事件`, "info");
    return;
  }
  if (action === "测试 Provider") {
    const adapter = notificationProviders.get(provider.kind);
    if (!adapter) { ui.notify("Provider 类型不受支持", "warning"); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await adapter.test(provider, controller.signal);
      ui.notify(`${provider.id}: ${result.ok ? "测试成功" : `测试失败（${result.code}）`}`, result.ok ? "info" : "warning");
    } catch {
      ui.notify(`${provider.id}: 测试失败（provider_error）`, "warning");
    } finally { clearTimeout(timer); }
  }
}


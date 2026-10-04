import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { NotificationConfigStore } from "./notifications/notification-config.js";
import { notificationProviders } from "./notifications/providers/index.js";
import { isNotificationKind, isNotificationProviderKind, type NotificationKind, type NotificationProviderConfig, type NotificationProviderKind } from "./notifications/notification-types.js";
import { DEFAULT_NOTIFICATION_KINDS, NOTIFICATION_CONFIG_PATH } from "./notification-cli.js";

type FormField = { id: string; label: string; secret?: boolean; placeholder?: string };
type ProviderFormResult = { id: string; name: string; settings: Record<string, string> };
type ProviderFormOptions = { initial?: NotificationProviderConfig; idEditable?: boolean };

const PROVIDER_FIELDS: Record<NotificationProviderKind, FormField[]> = {
  pushdeer: [
    { id: "pushkey", label: "PushKey", secret: true },
    { id: "endpoint", label: "Endpoint（可选）", placeholder: "https://api2.pushdeer.com" },
  ],
  ntfy: [
    { id: "server", label: "Server", placeholder: "https://ntfy.sh" },
    { id: "topic", label: "Topic" },
    { id: "token", label: "Token（可选）", secret: true },
  ],
  bark: [
    { id: "server", label: "Server", placeholder: "https://api.day.app" },
    { id: "deviceKey", label: "Device Key", secret: true },
    { id: "sound", label: "Sound（可选）", placeholder: "birdsong" },
  ],
  gotify: [
    { id: "server", label: "Server" },
    { id: "token", label: "Token", secret: true },
  ],
  telegram: [
    { id: "botToken", label: "Bot Token", secret: true },
    { id: "chatId", label: "Chat ID" },
  ],
  webhook: [
    { id: "url", label: "URL" },
    { id: "headers", label: "Headers JSON（可选）", secret: true },
  ],
};

export function defaultProviderSettings(kind: NotificationProviderKind): Record<string, string> {
  if (kind === "ntfy") return { server: "https://ntfy.sh" };
  if (kind === "bark") return { server: "https://api.day.app" };
  return {};
}

class ProviderForm implements Component, Focusable {
  focused = true;
  private selected = 0;
  private values: Record<string, string> = {};
  private editing = false;
  private readonly idEditable: boolean;

  constructor(
    private readonly kind: NotificationProviderKind,
    private readonly fields: readonly FormField[],
    private readonly done: (result: ProviderFormResult | undefined) => void,
    private readonly requestRender: () => void,
    private readonly theme: Theme,
    options: ProviderFormOptions = {},
  ) {
    this.idEditable = options.idEditable ?? true;
    const initial = options.initial;
    if (initial) {
      this.values.id = initial.id;
      this.values.name = initial.name;
    } else {
      Object.assign(this.values, defaultProviderSettings(kind));
    }
    for (const field of fields) {
      if (field.secret) continue;
      const value = initial?.settings[field.id];
      if (typeof value === "string") this.values[field.id] = value;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(24, Math.min(100, Math.trunc(width) - 4));
    const bg = (text: string) => this.theme.bg("customMessageBg", text);
    const border = this.theme.fg("borderMuted", "│");
    const horizontal = this.theme.fg("borderMuted", "─".repeat(inner));
    const title = this.theme.fg("accent", ` Provider ${this.kind} `);
    const lines = [
      `${border}${title}${this.theme.fg("borderMuted", "─".repeat(Math.max(0, inner - title.length)))}${border}`,
      ...this.fieldLines().map((line) => `${border}${bg(` ${line.padEnd(Math.max(0, inner - 2)).slice(0, Math.max(0, inner - 2))} `)}${border}`),
      `${border}${horizontal}${border}`,
      `${border}${this.theme.fg("dim", "↑↓ 选择 · Enter 编辑/确认 · Ctrl+S 保存 · Esc 取消").padEnd(inner)}${border}`,
      `${border}${horizontal}${border}`,
    ];
    return lines;
  }

  private fieldLines(): string[] {
    const all: FormField[] = [
      { id: "id", label: "Provider ID" },
      { id: "name", label: "显示名称" },
      ...this.fields,
    ];
    return all.map((field, index) => {
      const active = index === this.selected ? (this.editing ? "✎" : "›") : " ";
      const value = this.values[field.id] ?? "";
      const renderedValue = field.secret ? (value ? "*".repeat(Math.min(24, value.length)) : "（未设置）") : (value || field.placeholder || "（未设置）");
      const rendered = this.editing && index === this.selected ? `${renderedValue}▌` : renderedValue;
      return `${active} ${field.label}: ${rendered}`;
    });
  }

  handleInput(data: string): void {
    const fields: FormField[] = [{ id: "id", label: "Provider ID" }, { id: "name", label: "显示名称" }, ...this.fields];
    if (matchesKey(data, Key.ctrl("s")) || data === "\x13") {
      const id = (this.values.id ?? "").trim();
      const name = (this.values.name ?? id).trim();
      if (!id || !name) return;
      const settings = Object.fromEntries(Object.entries(this.values).filter(([key, value]) => key !== "id" && key !== "name" && value !== undefined && value !== ""));
      this.done({ id, name, settings });
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.editing) { this.editing = false; this.requestRender(); } else this.done(undefined);
      return;
    }
    if (!this.editing && matchesKey(data, Key.up)) { this.selected = Math.max(0, this.selected - 1); this.requestRender(); return; }
    if (!this.editing && (matchesKey(data, Key.down) || matchesKey(data, Key.tab))) { this.selected = Math.min(fields.length - 1, this.selected + 1); this.requestRender(); return; }
    if (this.editing && matchesKey(data, Key.backspace)) {
      if (this.selected === 0 && !this.idEditable) return;
      const field = fields[this.selected]!;
      this.values[field.id] = (this.values[field.id] ?? "").slice(0, -1);
      this.requestRender(); return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.editing) { this.editing = false; this.requestRender(); }
      else { this.editing = true; this.requestRender(); }
      return;
    }
    if (this.editing && data.length > 0 && !data.includes("\u001b") && !data.includes("\n") && !data.includes("\r")) {
      if (this.selected === 0 && !this.idEditable) return;
      const field = fields[this.selected]!;
      this.values[field.id] = (this.values[field.id] ?? "") + data;
      this.requestRender();
    }
    return;
  }
}

async function openProviderForm(ctx: ExtensionContext, kind: NotificationProviderKind, options: ProviderFormOptions = {}): Promise<ProviderFormResult | undefined> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return undefined;
  return ctx.ui.custom<ProviderFormResult | undefined>((tui, theme, _keybindings, done) => new ProviderForm(kind, PROVIDER_FIELDS[kind], done, () => tui.requestRender(), theme, options), {
    overlay: true,
    overlayOptions: { anchor: "center", width: "88%", maxHeight: "90%" },
  });
}

export async function runNotificationTui(ctx: ExtensionContext): Promise<void> {
  const ui = ctx.ui as unknown as {
    select?: (message: string, options: string[]) => Promise<string>;
    input?: (message: string) => Promise<string>;
    confirm?: (message: string) => Promise<boolean>;
    notify: (message: string, level: "info" | "warning") => void;
  };
  if (!ui.select) {
    ui.notify("maestro-mobile notify：当前 TUI 不支持交互表单，请使用 CLI；不会在 TUI 中收集 secret", "warning");
    return;
  }
  const store = new NotificationConfigStore(NOTIFICATION_CONFIG_PATH);
  const action = await ui.select("通知管理", ["查看 Provider", "新增 Provider", "编辑 Provider", "修改通知事件", "测试 Provider", "删除 Provider", "退出"]);
  if (action === "退出") return;
  const config = await store.read();
  if (action === "新增 Provider") {
    const kind = await ui.select("选择 Provider 类型", ["pushdeer", "ntfy", "bark", "gotify", "telegram", "webhook"]);
    if (!isNotificationProviderKind(kind)) return;
    const form = await openProviderForm(ctx, kind);
    if (!form) { ui.notify("当前 TUI 不支持安全 Provider 表单，请使用 CLI", "warning"); return; }
    try {
      const provider: NotificationProviderConfig = { id: form.id, kind, name: form.name, enabled: true, eventKinds: [...DEFAULT_NOTIFICATION_KINDS], settings: Object.fromEntries(Object.entries(form.settings).filter(([, value]) => value !== undefined && value !== "")) };
      notificationProviders.get(kind)?.validate(provider);
      await store.upsertProvider(provider);
      ui.notify(`已保存 ${form.id}（secret 已遮罩）`, "info");
    } catch (error) {
      ui.notify(`保存失败：${error instanceof Error ? error.message : "invalid_provider_config"}`, "warning");
    }
    return;
  }
  if (action === "编辑 Provider") {
    const providerId = await ui.select("选择 Provider", config.providers.map((provider) => provider.id));
    const existing = config.providers.find((entry) => entry.id === providerId);
    if (!existing) return;
    const form = await openProviderForm(ctx, existing.kind, { initial: existing, idEditable: false });
    if (!form) { ui.notify("当前 TUI 不支持安全 Provider 表单，请使用 CLI", "warning"); return; }
    try {
      await store.updateProvider(existing.id, {
        name: form.name,
        settings: form.settings,
      });
      ui.notify(`已更新 ${existing.id}（secret 留空表示保留原值）`, "info");
    } catch (error) {
      ui.notify(`保存失败：${error instanceof Error ? error.message : "invalid_provider_config"}`, "warning");
    }
    return;
  }
  if (action === "查看 Provider") {
    ui.notify(config.providers.length === 0 ? "暂无 Provider" : config.providers.map((provider) => `${provider.id} · ${provider.kind} · ${provider.enabled ? "启用" : "停用"} · events=${provider.eventKinds.join(",")}`).join("\n"), "info");
    return;
  }
  if (config.providers.length === 0) {
    ui.notify("暂无 Provider；请选择“新增 Provider”或使用 CLI", "warning");
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

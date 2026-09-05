/**
 * MaestroSettingsService — 读写 pi-maestro-flow 的配置 JSON 文件（只读安全窗口 + 谨慎写）
 *
 * 覆盖 pi-maestro-flow /maestro-settings /api-manager 持久化的文件：
 *  - ~/.pi/agent/settings.json        （默认模型/主题/重试/包等）
 *  - ~/.pi/agent/models.json          （模型定义）
 *  - ~/.pi/agent/api-manager.json     （api manager：managedProviders/nextSuggest 等）
 *  - ~/.pi/agent/mcp.json             （MCP 服务器）
 *  - ~/.pi/agent/keybindings.json     （键位，只读展示）
 *  - ~/.pi/maestro-chinese-response-mode.json
 *
 * 写安全：只更新白名单字段（defaultModel/defaultProvider/defaultThinkingLevel/theme），
 * 完整写回前备份。
 */
import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const MAESTRO_DIR = join(homedir(), ".pi");

export interface SettingsNode {
  key: string;
  label: string;
  path: string;
  /** 浅层 JSON 快照（供展示）；敏感文件恒为 {} */
  data: Record<string, unknown>;
  /** 敏感文件（auth/api-manager 等）已脱敏：仅返回存在性与顶层 keys，无任何值 */
  redacted?: boolean;
  /** 敏感文件时返回顶层 key 列表 */
  topLevelKeys?: string[];
}

export interface SettingsOverview {
  files: SettingsNode[];
  observedAt: string;
}

/** 可安全写入的字段（白名单，防破坏 maestro 运行时状态） */
const WRITABLE_DEFAULTS = ["defaultModel", "defaultProvider", "defaultThinkingLevel", "theme", "hideThinkingBlock"] as const;

const FILES: { key: string; label: string; path: string; sub?: string }[] = [
  { key: "settings", label: "Maestro 设置", path: join(AGENT_DIR, "settings.json") },
  { key: "models", label: "模型", path: join(AGENT_DIR, "models.json") },
  { key: "api-manager", label: "API 管理", path: join(AGENT_DIR, "api-manager.json") },
  { key: "mcp", label: "MCP 服务器", path: join(AGENT_DIR, "mcp.json") },
  { key: "auth", label: "认证", path: join(AGENT_DIR, "auth.json") },
  { key: "keybindings", label: "快捷键", path: join(AGENT_DIR, "keybindings.json") },
  { key: "cockpit", label: "Cockpit", path: join(AGENT_DIR, "cockpit.json") },
  { key: "maestro-ui", label: "Maestro UI", path: join(AGENT_DIR, "maestro-ui.json") },
  { key: "lsp", label: "LSP", path: join(AGENT_DIR, "lsp.json") },
  { key: "chinese-mode", label: "中文回复模式", path: join(MAESTRO_DIR, "maestro-chinese-response-mode.json") },
];

/**
 * 敏感文件（P1-4）：含 API 密钥的文件只返回存在性与顶层 keys，值永不离开宿主机。
 */
const SENSITIVE_FILE_KEYS = new Set(["auth", "api-manager"]);

/** 读取所有设置文件的浅层快照 */
export async function readSettingsOverview(): Promise<SettingsOverview> {
  const files: SettingsNode[] = [];
  for (const f of FILES) {
    try {
      const raw = await readFile(f.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (SENSITIVE_FILE_KEYS.has(f.key)) {
        files.push({
          key: f.key,
          label: f.label,
          path: f.path,
          data: {},
          redacted: true,
          topLevelKeys: Object.keys(parsed),
        });
      } else {
        files.push({ key: f.key, label: f.label, path: f.path, data: parsed });
      }
    } catch {
      // 文件不存在或不可解析 → 跳过
    }
  }
  return { files, observedAt: new Date().toISOString() };
}

/** 读取单个设置文件 */
export async function readSettingsFile(key: string): Promise<{ path: string; data: Record<string, unknown> } | undefined> {
  const f = FILES.find((x) => x.key === key);
  if (!f) return undefined;
  try {
    const raw = await readFile(f.path, "utf8");
    return { path: f.path, data: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/**
 * 安全更新 settings.json 的白名单字段。
 * 写前备份（.bak-<ts>），避免破坏 maestro 运行时配置。
 */
export async function updateSettingsJson(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const path = join(AGENT_DIR, "settings.json");
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `读取 settings.json 失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 只允许白名单字段
  const allowed = new Set<string>(WRITABLE_DEFAULTS);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    if (typeof v === "string" && v.trim()) clean[k] = v.trim();
    if (typeof v === "boolean") clean[k] = v;
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, error: "没有可写的白名单字段" };
  }

  // 备份
  try {
    await copyFile(path, `${path}.bak-${Date.now()}`);
  } catch {
    // 备份失败不阻塞（尽力而为）
  }

  const next = { ...current, ...clean };
  try {
    await writeFile(path, JSON.stringify(next, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export { WRITABLE_DEFAULTS, FILES };
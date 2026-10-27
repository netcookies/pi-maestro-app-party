import { stat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface FavoriteTuiUi {
  select?: (message: string, options: string[]) => Promise<string | undefined>;
  input?: (message: string, placeholder?: string) => Promise<string | undefined>;
  confirm?: (message: string) => Promise<boolean>;
  notify: (message: string, level: "info" | "warning" | "error") => void;
}

export interface FavoriteTuiHost {
  /** 通过本地 HTTP 请求 Host 落盘；返回 false 表示 Host 不可达（调用方应放弃本次修改） */
  commit(patch: { addFavorite?: string; removeFavorite?: string; reorderFavorites?: string[] }): Promise<boolean>;
}

const ADD_CURRENT = "＋ 添加当前目录";
const ADD_CUSTOM = "＋ 添加自定义路径（输入）";
const FILTER = "🔍 按关键字过滤后操作";
const DONE = "✓ 完成";
const MAX_FILTERED = 20;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function promptPath(ui: FavoriteTuiUi, title: string, initial: string): Promise<string | undefined> {
  if (!ui.input) {
    ui.notify("当前 TUI 不支持输入框，无法添加自定义路径", "warning");
    return undefined;
  }
  const raw = await ui.input(title, initial);
  const value = (raw ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/** 提交并刷新；Host 不可达时放弃本次修改（不直写文件，避免与 Host 交叉写）。 */
async function apply(ui: FavoriteTuiUi, host: FavoriteTuiHost, patch: Parameters<FavoriteTuiHost["commit"]>[0], successMessage: string, list: () => Promise<string[]>): Promise<string[] | undefined> {
  const applied = await host.commit(patch);
  if (!applied) {
    ui.notify("Host 未响应，本次修改已放弃（不会直接改写配置文件，避免与 Host 交叉写）", "warning");
    return undefined;
  }
  ui.notify(successMessage, "info");
  return list();
}

function move(favorites: string[], from: number, delta: number): string[] | undefined {
  const to = from + delta;
  if (from < 0 || to < 0 || to >= favorites.length) return undefined;
  const next = [...favorites];
  next[from] = favorites[to]!;
  next[to] = favorites[from]!;
  return next;
}

export async function runFavoriteTui(ctx: ExtensionContext, host: FavoriteTuiHost, currentCwd: string, list: () => Promise<string[]>): Promise<void> {
  const ui = ctx.ui as unknown as FavoriteTuiUi;
  if (!ui.select) {
    ui.notify("maestro-mobile manager-fav：当前 TUI 不支持交互菜单", "warning");
    return;
  }

  let favorites = await list();
  while (true) {
    const choice = await ui.select(
      `常用工作目录管理（${favorites.length} 条 · 修改即时生效）`,
      [...favorites.map((path, index) => `[${index + 1}] ${path}`), ADD_CURRENT, ADD_CUSTOM, FILTER, DONE],
    );
    if (!choice || choice === DONE) return;

    if (choice === ADD_CURRENT) {
      if (favorites.includes(currentCwd)) {
        ui.notify("当前目录已在常用列表中", "info");
        continue;
      }
      const next = await apply(ui, host, { addFavorite: currentCwd }, `已添加 ${currentCwd}`, list);
      if (next) favorites = next;
      continue;
    }

    if (choice === ADD_CUSTOM) {
      const path = await promptPath(ui, "输入工作目录绝对路径", currentCwd);
      if (!path) continue;
      if (!path.startsWith("/") || !(await isDirectory(path))) {
        ui.notify("路径必须是已存在的绝对目录", "warning");
        continue;
      }
      if (favorites.includes(path)) {
        ui.notify("该目录已在常用列表中", "info");
        continue;
      }
      const next = await apply(ui, host, { addFavorite: path }, `已添加 ${path}`, list);
      if (next) favorites = next;
      continue;
    }

    if (choice === FILTER) {
      const keyword = (await promptPath(ui, "输入过滤关键字", "")) ?? "";
      const matched = favorites.filter((path) => path.includes(keyword)).slice(0, MAX_FILTERED);
      if (matched.length === 0) {
        ui.notify("没有匹配的目录", "info");
        continue;
      }
      const picked = await ui.select(`匹配 ${matched.length} 条，选择要操作的目录`, [...matched, "（返回）"]);
      if (!picked || picked === "（返回）" || !matched.includes(picked)) continue;
      favorites = (await operateOn(ui, host, picked, favorites, list)) ?? favorites;
      continue;
    }

    const picked = choice.replace(/^\[\d+\]\s*/, "");
    if (!favorites.includes(picked)) continue;
    favorites = (await operateOn(ui, host, picked, favorites, list)) ?? favorites;
  }
}

async function operateOn(ui: FavoriteTuiUi, host: FavoriteTuiHost, path: string, favorites: string[], list: () => Promise<string[]>): Promise<string[] | undefined> {
  const action = await ui.select?.(path, ["删除", "上移", "下移", "（返回）"]);
  if (!action || action === "（返回）") return undefined;
  if (action === "删除") {
    if (ui.confirm && !(await ui.confirm(`确认从常用目录中移除 ${path}？`))) return undefined;
    return apply(ui, host, { removeFavorite: path }, `已移除 ${path}`, list);
  }
  const reordered = move(favorites, favorites.indexOf(path), action === "上移" ? -1 : 1);
  if (!reordered) {
    ui.notify("已在边界，无法继续移动", "info");
    return undefined;
  }
  return apply(ui, host, { reorderFavorites: reordered }, `已移动 ${path}`, list);
}

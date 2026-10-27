/**
 * 分离子进程（Host / Broker）必须跑在 JS runtime 上。
 *
 * `process.execPath` 只在 Pi 自己跑在 Node（或真正的 Bun）上时才是 runtime。
 * 单文件应用构建（pi-bolt 的 `pi-bin`）里它指向 Pi 应用本身，于是
 * `spawn(process.execPath, [script])` 会再启动一个 Pi 会话而不是执行脚本：
 * 每次重试都多一个 agent 进程，各自跑完一轮还会触发一次「回复已完成」通知。
 */
const RUNTIME_NAMES = new Set(["node", "node.exe", "nodejs", "nodejs.exe", "bun", "bun.exe"]);

/** 该可执行文件是否是可以直接执行 `.js` 脚本的 runtime（而非应用打包产物）。 */
export function isJavaScriptRuntimePath(executable: string): boolean {
  const name = executable.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return RUNTIME_NAMES.has(name);
}

/**
 * 解析执行脚本用的可执行文件。
 * 显式覆盖（`MAESTRO_MOBILE_NODE_BIN`）优先；`process.execPath` 是 runtime 时复用它
 * （保持原有 Node/Bun 部署行为）；否则回退 PATH 上的 node。
 */
export function resolveNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  const override = env.MAESTRO_MOBILE_NODE_BIN?.trim();
  if (override) return override;
  if (isJavaScriptRuntimePath(execPath)) return execPath;
  return process.platform === "win32" ? "node.exe" : "node";
}

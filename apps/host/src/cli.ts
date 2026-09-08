#!/usr/bin/env node
/**
 * maestro-mobile — Host 守护进程入口
 *
 * 用法：
 *   maestro-mobile [--port 4739] [--host 0.0.0.0] [--token <secret>] [--project-root <dir>] [--poll-ms 5000]
 *
 * 环境变量（与 CLI 参数等价）：
 *   MAESTRO_MOBILE_PORT / MAESTRO_MOBILE_HOST / MAESTRO_MOBILE_TOKEN / MAESTRO_MOBILE_PROJECT_ROOT
 *
 * 安全：token 强制启用 —— 未提供 --token/环境变量时自动生成并持久化到 ~/.pi/maestro-mobile-token。
 * WS 握手校验 Origin（loopback 与绑定 host 白名单）。
 */
import { HostController } from "./host-controller.js";
import { MobileHostServer } from "./server/mobile-host-server.js";
import { MaestroStateReader } from "./maestro-state.js";
import { PiSdkRuntimeFactory } from "./pi/pi-sdk-runtime.js";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_FILE = join(homedir(), ".pi", "maestro-mobile-token");
/** PID 文件（与 extension start/stop 共用同一语义：谁起的都能被 /maestro-mobile stop 停掉） */
const PID_FILE = join(homedir(), ".pi", "maestro-mobile.pid");

/** 读取或创建持久化 token（重启不变号，手机连接配置不失效） */
async function loadOrCreateToken(): Promise<string> {
  try {
    const saved = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (saved.length >= 24) return saved;
  } catch {
    // 文件不存在 → 创建
  }
  const token = randomBytes(24).toString("hex");
  await mkdir(join(homedir(), ".pi"), { recursive: true });
  await writeFile(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

interface CliArgs {
  port: number;
  host: string;
  token?: string;
  projectRoot: string;
  pollMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
      args.set(key, value);
      if (value !== "true") i++;
    }
  }

  const port = Number(args.get("port") ?? process.env.MAESTRO_MOBILE_PORT ?? "4739");
  // 默认 0.0.0.0（手机直连）；强制 token：未提供时自动生成并持久化到 ~/.pi/maestro-mobile-token，
  // 重启不换号（手机连接配置不失效），换号需删除该文件或显式 --token
  const host = args.get("host") ?? process.env.MAESTRO_MOBILE_HOST ?? "0.0.0.0";
  const token = args.get("token") ?? process.env.MAESTRO_MOBILE_TOKEN ?? undefined;
  const projectRoot = args.get("project-root") ?? process.env.MAESTRO_MOBILE_PROJECT_ROOT ?? process.cwd();
  const pollMs = Number(args.get("poll-ms") ?? process.env.MAESTRO_MOBILE_POLL_MS ?? "5000");

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return { port, host, token, projectRoot, pollMs };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // 默认行为（无子命令）：已启动 → 打印 status 退出；未启动 → 继续正常启动。
  // 显式传 --port/-host 等参数时跳过该探测（用户明确要起一个实例）。
  const hasPositional = process.argv.slice(2).some((a) => !a.startsWith("--") && !/^(4739|\d+|0\.0\.0\.0|127\.0\.0\.1|localhost)$/.test(a));
  const explicitFlags = process.argv.slice(2).filter((a) => a === "--port" || a === "--host").length > 0;
  if (!hasPositional && !explicitFlags) {
    try {
      const res = await fetch(`http://127.0.0.1:${cli.port}/api/health`, { signal: AbortSignal.timeout(1200) });
      // 已有实例：打印 status 后退出（不重复起进程）
      const persisted = await loadOrCreateToken();
      const s = await fetch(`http://127.0.0.1:${cli.port}/api/status`, {
        headers: { Authorization: `Bearer ${persisted}` },
        signal: AbortSignal.timeout(1500),
      });
      if (s.ok) {
        const d = (await s.json()) as { version?: string; sessions?: number; uptimeMs?: number; piVersion?: string };
        console.log(`[maestro-mobile] 已在运行 :${cli.port} — v${d.version ?? "?"} · ${d.sessions ?? 0} 会话 · 运行 ${Math.round((d.uptimeMs ?? 0) / 60000)} 分钟 · pi ${d.piVersion ?? "?"}`);
        console.log(`[maestro-mobile] token: ${persisted.slice(0, 6)}…${persisted.slice(-4)}（完整值 ${TOKEN_FILE} 或 /maestro-mobile qr）`);
        return;
      }
    } catch { /* 未启动 → 继续启动 */ }
  }

  // P0-1：强制 token —— 未提供时生成并持久化到 ~/.pi/maestro-mobile-token（重启不变号）
  const token = cli.token ?? (await loadOrCreateToken());
  if (!cli.token) {
    console.log(`[maestro-mobile] no --token provided; using persisted token (${TOKEN_FILE}):`);
    console.log(`[maestro-mobile]   token: ${token}`);
  }

  console.log(`[maestro-mobile] starting on ${cli.host}:${cli.port} (project: ${cli.projectRoot})`);

  const runtimeFactory = new PiSdkRuntimeFactory();
  const maestroReader = new MaestroStateReader({ projectRoot: cli.projectRoot });
  const controller = new HostController(runtimeFactory, maestroReader);
  const server = new MobileHostServer(controller, { token });

  await server.listen(cli.port, cli.host);
  await controller.startMaestroPoll(cli.pollMs);

  console.log(`[maestro-mobile] listening on http://${cli.host}:${server.address().port}`);
  console.log(`[maestro-mobile] token auth enabled (use ?token= or Bearer header)`);
  // 写 PID 文件：/maestro-mobile stop 能停掉 cli 直接启动的实例（与 extension start 一致）
  await writeFile(PID_FILE, String(process.pid), "utf8");

  // 优雅关闭
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[maestro-mobile] received ${signal}, shutting down...`);
    await controller.dispose();
    await server.close();
    await unlink(PID_FILE).catch(() => {});
    console.log("[maestro-mobile] shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    // P3-6：未捕获异常后进程状态不可信，记录后带清理退出，避免带伤继续服务
    console.error("[maestro-mobile] uncaught exception, shutting down:", error);
    void shutdown("uncaughtException").finally(() => process.exit(1));
  });
}

main().catch((error) => {
  console.error("[maestro-mobile] fatal:", error);
  process.exit(1);
});
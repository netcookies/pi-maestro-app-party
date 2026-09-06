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
 * 安全：token 强制启用 —— 未提供 --token/环境变量时自动生成随机 token 并打印到 stdout。
 * WS 握手校验 Origin（loopback 与绑定 host 白名单）。
 */
import { HostController } from "./host-controller.js";
import { MobileHostServer } from "./server/mobile-host-server.js";
import { MaestroStateReader } from "./maestro-state.js";
import { PiSdkRuntimeFactory } from "./pi/pi-sdk-runtime.js";
import { randomBytes } from "node:crypto";

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
  // 安全默认：仅监听 loopback；显式 --host 0.0.0.0 才对 LAN 开放（README 安全节提醒配 token）
  const host = args.get("host") ?? process.env.MAESTRO_MOBILE_HOST ?? "127.0.0.1";
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

  // P0-1：无 token 拒绝裸奔 —— 自动生成随机会话 token 并打印，避免 LAN 内无鉴权全权暴露
  const token = cli.token ?? randomBytes(24).toString("hex");
  if (!cli.token) {
    console.log("[maestro-mobile] no --token provided; generated an ephemeral token for this run:");
    console.log(`[maestro-mobile]   token: ${token}`);
    console.log("[maestro-mobile]   (set MAESTRO_MOBILE_TOKEN or pass --token to reuse a stable token)");
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

  // 优雅关闭
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[maestro-mobile] received ${signal}, shutting down...`);
    await controller.dispose();
    await server.close();
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
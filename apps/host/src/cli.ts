#!/usr/bin/env node
/**
 * maestro-mobile-host — Host 守护进程入口
 *
 * 用法：
 *   maestro-mobile-host [--port 4739] [--host 0.0.0.0] [--token <secret>] [--project-root <dir>] [--poll-ms 5000]
 *
 * 环境变量（与 CLI 参数等价）：
 *   MAESTRO_MOBILE_PORT / MAESTRO_MOBILE_HOST / MAESTRO_MOBILE_TOKEN / MAESTRO_MOBILE_PROJECT_ROOT
 */
import { HostController } from "./host-controller.js";
import { MobileHostServer } from "./server/mobile-host-server.js";
import { MaestroStateReader } from "./maestro-state.js";
import { PiSdkRuntimeFactory } from "./pi/pi-sdk-runtime.js";

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

  console.log(`[maestro-mobile-host] starting on ${cli.host}:${cli.port} (project: ${cli.projectRoot})`);

  const runtimeFactory = new PiSdkRuntimeFactory();
  const maestroReader = new MaestroStateReader({ projectRoot: cli.projectRoot });
  const controller = new HostController(runtimeFactory, maestroReader);
  const server = new MobileHostServer(controller, cli.token ? { token: cli.token } : {});

  await server.listen(cli.port, cli.host);
  await controller.startMaestroPoll(cli.pollMs);

  console.log(`[maestro-mobile-host] listening on http://${cli.host}:${server.address().port}`);
  if (cli.token) {
    console.log(`[maestro-mobile-host] token auth enabled (use ?token= or Bearer header)`);
  }

  // 优雅关闭
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[maestro-mobile-host] received ${signal}, shutting down...`);
    await controller.dispose();
    await server.close();
    console.log("[maestro-mobile-host] shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    console.error("[maestro-mobile-host] uncaught exception:", error);
  });
}

main().catch((error) => {
  console.error("[maestro-mobile-host] fatal:", error);
  process.exit(1);
});
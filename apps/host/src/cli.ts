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

/** 仅当 PID 文件指向本进程时删除，避免误删其他实例的 PID */
/** 日志用：抹掉 argv 中 --token 的值（明文密钥不能落盘到 ~/.pi/maestro-mobile.log） */
function redactArgv(argv: string[]): string {
  const SENSITIVE = new Set(["token"]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const hasValue = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--");
      out.push(arg);
      if (hasValue) out.push(SENSITIVE.has(key) ? "[redacted]" : argv[++i]);
    } else {
      out.push(arg);
    }
  }
  return out.join(" ");
}

async function unlinkIfOwned(path: string, ownPid: number): Promise<void> {
  try {
    const saved = Number((await readFile(path, "utf8")).trim());
    if (saved === ownPid) await unlink(path);
  } catch { /* 文件不存在或不可读：无需清理 */ }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // P0-3：进程级 handler 必须在任何 await 之前注册。原先它们挂在 listen() 之后，
  // 启动期（token 读写、listen、版本探测）的异常会绕过统一清理路径，以原生栈崩溃。
  // controller/server 此时尚未构造，用 late 绑定延后注入。
  const late: { controller?: HostController; server?: MobileHostServer } = {};
  let shuttingDown = false;
  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[maestro-mobile] received ${reason}, shutting down...`);
    // 关闭失败不应阻断退出（例如 listen 未成功时 close 会抛 ERR_SERVER_NOT_RUNNING）
    await late.controller?.dispose().catch(() => { });
    await late.server?.close().catch(() => { });
    // 只能删自己写的 PID：崩在 writeFile 之前时，文件属于另一个存活实例，误删会使 /maestro-mobile stop 失效
    await unlinkIfOwned(PID_FILE, process.pid);
    console.log("[maestro-mobile] shutdown complete");
    // exitCode 必须是参数：原先固定 exit(0) 会让 launchd/systemd（KeepAlive.SuccessfulExit=false）
    // 把崩溃当成正常退出而永不拉起，表现为“host 无声消失”
    process.exit(exitCode);
  }
  const fatal = (label: string, error: unknown): void => {
    console.error(`[maestro-mobile] ${label}, shutting down:`, error);
    // 附带现场信息：extension 以 stdio:"ignore" 拉起时无终端输出，日志是唯一线索。
    // argv 里的 --token 值必须脱敏：此输出会被 extension 落盘到 ~/.pi/maestro-mobile.log，
    // 不能把明文密钥写进日志文件。
    console.error(`[maestro-mobile]   pid=${process.pid} node=${process.version} cwd=${process.cwd()} argv=${redactArgv(process.argv.slice(1))}`);
    void shutdown(label, 1);
  };
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  // SIGHUP：Node 默认动作是「静默终止」——实测无输出、无退出码打印、也不会生成 macOS .ips 报告，
  // 表现为 host “无声消失”且无从查起。它可由终端挂断 / 登录会话结束传导过来，
  // 即使 spawn 已 detached 也不能完全依赖。
  // 这里仍保持“终止”语义（不改成忽略，避免留下没人管的孤儿进程），但走优雅关闭：
  // 留日志 + 删自己写的 PID 文件，不再留下 stale PID 让 /maestro-mobile stop 失效。
  process.on("SIGHUP", () => void shutdown("SIGHUP", 0));
  process.on("uncaughtException", (error) => fatal("uncaught exception", error));
  // Node 22+ 默认把未处理 Promise rejection 抛成 uncaughtException，这里显式接管以拿到上下文并走优雅关闭
  process.on("unhandledRejection", (reason) => fatal("unhandled rejection", reason));

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

  late.controller = controller;
  late.server = server;
  try {
    await server.listen(cli.port, cli.host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      console.error(`[maestro-mobile] 端口 ${cli.port} 已被占用 —— 很可能已有实例在运行。`);
      console.error(`[maestro-mobile] 查看状态：/maestro-mobile status；停止：/maestro-mobile stop`);
      console.error(`[maestro-mobile] 需要并行起第二个实例请用 --port <其他端口>`);
    } else {
      console.error(`[maestro-mobile] 监听 ${cli.host}:${cli.port} 失败（${code ?? "unknown"}）:`, error);
    }
    await controller.dispose().catch(() => { });
    process.exit(1);
  }
  await controller.startMaestroPoll(cli.pollMs);

  console.log(`[maestro-mobile] listening on http://${cli.host}:${server.address().port}`);
  console.log(`[maestro-mobile] token auth enabled (use ?token= or Bearer header)`);
  // 写 PID 文件：/maestro-mobile stop 能停掉 cli 直接启动的实例（与 extension start 一致）
  await writeFile(PID_FILE, String(process.pid), "utf8");
}

main().catch((error) => {
  console.error("[maestro-mobile] fatal:", error);
  process.exit(1);
});
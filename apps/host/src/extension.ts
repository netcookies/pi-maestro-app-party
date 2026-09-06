/**
 * maestro-host extension — 薄遥控器（用户提案：pi 扩展自动拉起 npm 包的 host）
 *
 * 职责边界（刻意保持薄）：
 *  - start:  幂等启动 host 子进程（detached；已在监听则跳过）
 *  - status: 探测 /api/health + /api/status
 *  - stop:   杀掉由本扩展启动的 host（PID 文件校验，防误杀外部 launchd/systemd 实例）
 *
 * host 仍是独立常驻进程（不随 Pi 会话生灭）；本扩展只做生命周期遥控。
 * 无 npm 包的 host 时（pi install 场景），spawn 同包 dist/cli.js。
 */
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PID_FILE = join(homedir(), ".pi", "maestro-host.pid");
const DEFAULT_PORT = 4739;

function hostPort(): number {
  const raw = process.env.MAESTRO_MOBILE_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

/** 探测 host 是否在监听：/api/health 200 或 401 都算 alive（401 = 服务在，仅缺 token） */
function probeHealth(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => resolve(r.status === 200 || r.status === 401))
      .catch(() => resolve(false));
  });
}

function hostStatus(port: number, timeoutMs = 800): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(async (r) => (r.ok ? (await r.json()) as Record<string, unknown> : null))
      .then((d) => resolve(d ?? null))
      .catch(() => resolve(null));
  });
}

/** host cli.js 入口：同包 dist（pi install npm:pi-maestro-host 时随包分发） */
function hostCliPath(): string {
  // dist/extension.js 与 dist/cli.js 同目录
  return join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_FILE, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export default function maestroHostExtension(pi: ExtensionAPI): void {
  pi.registerCommand("maestro-host", {
    description: "Maestro Mobile Host 遥控（status / start / stop）",
    handler: async (args: string, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      const port = hostPort();
      const alive = await probeHealth(port);

      if (sub === "status") {
        if (!alive) {
          ctx.ui.notify(`maestro-host: 未运行（端口 ${port} 无响应）`, "info");
          return;
        }
        const s = await hostStatus(port);
        const ver = s
          ? `${s.version} · pi ${s.piVersion ?? "?"} · flow ${s.flowVersion ?? "?"} · cli ${s.maestroCliVersion ?? "?"}`
          : "运行中（未配 token，版本详情需在 host 侧设置 MAESTRO_MOBILE_TOKEN 后由手机 App 查看）";
        ctx.ui.notify(`maestro-host: 运行中 :${port} — ${ver}`, "info");
        return;
      }

      if (sub === "start") {
        if (alive) {
          ctx.ui.notify(`maestro-host: 已在运行（:${port}），跳过启动`, "info");
          return;
        }
        const child = spawn(process.execPath, [hostCliPath(), "--port", String(port)], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, MAESTRO_MOBILE_PORT: String(port) },
        });
        child.unref();
        await writeFile(PID_FILE, String(child.pid ?? ""), "utf8");
        // 等待端口就绪（最多 3s）
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 300));
          if (await probeHealth(port)) {
            ctx.ui.notify(`maestro-host: 已启动 :${port} pid=${child.pid}`, "info");
            return;
          }
        }
        ctx.ui.notify("maestro-host: 启动后 3s 内未见 health 通过，请查日志", "warning");
        return;
      }

      if (sub === "stop") {
        const pid = await readPid();
        if (!pid) {
          ctx.ui.notify("maestro-host: 无本扩展启动的实例（PID 文件不存在）；launchd/systemd 管理的实例请用对应服务命令停", "warning");
          return;
        }
        try {
          process.kill(pid, "SIGTERM");
          await unlink(PID_FILE).catch(() => {});
          ctx.ui.notify(`maestro-host: 已发送 SIGTERM 到 pid=${pid}`, "info");
        } catch {
          await unlink(PID_FILE).catch(() => {});
          ctx.ui.notify(`maestro-host: pid=${pid} 已不存在，清理 PID 文件`, "info");
        }
        return;
      }

      ctx.ui.notify(`maestro-host: 未知子命令 "${sub}"（可用：status / start / stop）`, "warning");
    },
  });
}

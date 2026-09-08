/**
 * maestro-mobile extension — 薄遥控器（用户提案：pi 扩展自动拉起 npm 包的 host）
 *
 * 职责边界（刻意保持薄）：
 *  - start:  幂等启动 host 子进程（detached；已在监听则跳过；O_EXCL 竞争锁防多会话并发启动）
 *  - status: 探测 /api/health + /api/status，显示 token 摘要
 *  - qr:     终端二维码渲染 ws://<lan-ip>:port/ws?token=（手机 App 扫码即连）
 *  - stop:   杀掉由本扩展启动的 host（PID 文件校验，防误杀外部 launchd/systemd 实例）
 *  - widget: 状态栏常驻一行（● :port · N 窗口），30s 刷新
 *
 * host 仍是独立常驻进程（不随 Pi 会话生灭）；本扩展只做生命周期遥控。
 * 无 npm 包的 host 时（pi install 场景），spawn 同包 dist/cli.js。
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import qrcodeTerminal from "qrcode-terminal";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PID_FILE = join(homedir(), ".pi", "maestro-mobile.pid");
const TOKEN_FILE = join(homedir(), ".pi", "maestro-mobile-token");
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

/**
 * 探测本机全部候选 IPv4（给手机连接 URL 用；找不到回退 127.0.0.1）。
 * 决策（用户确认）：不过滤接口类型 —— VPN utun/Tailscale、Mac 桥接 bridge、Docker 网段全部保留，
 * 手机可能恰好通过其中某个网段可达；安全边界靠强制 token，不靠网段隐藏。
 * 仅排除 loopback 与无效 APIPA 自造地址；排序按常见家庭/办公网段优先（192.168 > 10.x > 172.16-31 > 其它），
 * QR 逐个渲染由用户挑能连的。
 */
function lanIpCandidates(): string[] {
  const rank = (ip: string): number => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  const candidates: { ip: string; r: number }[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // APIPA：未连上的自造地址
      candidates.push({ ip: a.address, r: rank(a.address) });
    }
  }
  candidates.sort((x, y) => x.r - y.r);
  return candidates.map((c) => c.ip);
}

function lanIp(): string {
  return lanIpCandidates()[0] ?? "127.0.0.1";
}

/** host cli.js 入口：同包 dist（pi install npm:pi-maestro-mobile 时随包分发） */
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

/** 读取持久化 token（host start 时生成；未启动过返回空） */
async function readToken(): Promise<string> {
  try {
    return (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

// ── 状态栏 status（嵌在 footer，与 EVOL 同一行）─────────────────

const STATUS_KEY = "maestro-mobile";
let statusCtx: ExtensionContext | null = null;

/** 刷新 footer status：● maestro-mobile :4739 · N 窗口（未运行时清除） */
async function refreshStatus(): Promise<void> {
  if (!statusCtx) return;
  const port = hostPort();
  const alive = await probeHealth(port);
  if (!alive) {
    statusCtx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  let windows = 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/workspace-telemetry`);
    if (r.ok) {
      const d = (await r.json()) as { aliveCount?: number };
      windows = d.aliveCount ?? 0;
    }
  } catch { /* 探测失败按 0 显示 */ }
  // setStatus 嵌入 footer 状态栏（与 EVOL/relay 同一行），不再占独立行
  statusCtx.ui.setStatus(STATUS_KEY, `● maestro-mobile :${port} · ${windows} 窗口`);
}

export default function maestroHostExtension(pi: ExtensionAPI): void {
  // 会话启动后挂 footer status（与 EVOL 同行）；30s 周期刷新（host 状态变化时感知）
  pi.on("session_start", (_event, ctx) => {
    statusCtx = ctx;
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 30_000);
    pi.on("session_shutdown", () => { clearInterval(timer); statusCtx = null; });
  });

  pi.registerCommand("maestro-mobile", {
    description: "Maestro Mobile Host 遥控（status / start / stop / qr）",
    handler: async (args: string, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "default";
      const port = hostPort();
      const alive = await probeHealth(port);

      // 默认（无子命令）：未启动 → 直接 start（与 cli 默认行为一致）
      if (sub === "default" && !alive) {
        const lockFile = PID_FILE + ".lock";
        try {
          await writeFile(lockFile, String(process.pid), { flag: "wx" });
        } catch {
          try {
            const lockPid = Number((await readFile(lockFile, "utf8")).trim());
            process.kill(lockPid, 0);
            ctx.ui.notify(`maestro-mobile: 另一会话正在启动（pid=${lockPid}），本次跳过`, "warning");
            return;
          } catch {
            await unlink(lockFile).catch(() => { });
            await writeFile(lockFile, String(process.pid), { flag: "wx" });
          }
        }
        const child = spawn(process.execPath, [hostCliPath(), "--port", String(port)], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, MAESTRO_MOBILE_PORT: String(port) },
        });
        child.unref();
        await writeFile(PID_FILE, String(child.pid ?? ""), "utf8");
        try {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 300));
            if (await probeHealth(port)) {
              ctx.ui.notify(`maestro-mobile: 已启动 :${port} pid=${child.pid}`, "info");
              void refreshStatus();
              return;
            }
          }
          ctx.ui.notify("maestro-mobile: 启动后 3s 内未见 health 通过，请查日志", "warning");
        } finally {
          await unlink(lockFile).catch(() => { });
        }
        return;
      }

      if (sub === "status" || sub === "default") {
        if (!alive) {
          ctx.ui.notify(`maestro-mobile: 未运行（端口 ${port} 无响应）`, "info");
          return;
        }
        const token = await readToken();
        const s = await hostStatus(port);
        const ver = s
          ? `${s.version} · pi ${s.piVersion ?? "?"} · flow ${s.flowVersion ?? "?"} · cli ${s.maestroCliVersion ?? "?"}`
          : "运行中（详情需 token，见下方）";
        const tokenLine = token
          ? `token: ${token.slice(0, 6)}…${token.slice(-4)}（完整值: ~/.pi/maestro-mobile-token 或 /maestro-mobile qr）`
          : "token: 未知（host 未持久化）";
        ctx.ui.notify(`maestro-mobile: 运行中 :${port} — ${ver}\n${tokenLine}`, "info");
        return;
      }

      if (sub === "qr") {
        if (!alive) {
          ctx.ui.notify("maestro-mobile: host 未运行，先 /maestro-mobile start", "warning");
          return;
        }
        const token = await readToken();
        if (!token) {
          ctx.ui.notify("maestro-mobile: 未找到 token（~/.pi/maestro-mobile-token），先用 /maestro-mobile start 启动一次", "warning");
          return;
        }
        // v0.2.8 短码 + 全候选 IP 列表：QR 带 8 位短码和逗号分隔的全部候选 IP（~107 字符 / 21 行，
        // 在实测可扫尺寸内；逗号不编码省 30+ 字符）。App 对每个候选并行换码，任一可达即可配对
        // ——修复 0.2.7「首选 IP 恰好不可达则死锁」（4 候选 3 可达但首选不可达的场景）。
        const ips = lanIpCandidates();
        const shown = ips.length > 0 ? ips : ["127.0.0.1"];
        const code = Array.from({ length: 8 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");
        const { setPairingCode } = await import("./server/pairing-codes.js");
        await setPairingCode(code, { token, ips: shown, port });
        const url = `maestro-mobile://pair?c=${code}&i=${shown.join(",")}&p=${port}`;
        ctx.ui.notify(`配对短码: ${code}（5 分钟内有效）· ${shown.length} 个候选地址`, "info");
        qrcodeTerminal.generate(url, { small: true }, (q: string) => {
          ctx.ui.notify(q, "info");
        });
        return;
      }

      if (sub === "start") {
        if (alive) {
          ctx.ui.notify(`maestro-mobile: 已在运行（:${port}），跳过启动`, "info");
          return;
        }
        // 多 Pi 会话同时 start 的竞争锁：O_EXCL 抢占式创建，抢不到的会话直接退出
        const lockFile = PID_FILE + ".lock";
        let gotLock = false;
        try {
          await writeFile(lockFile, String(process.pid), { flag: "wx" });
          gotLock = true;
        } catch {
          // 锁已被占 —— 检查持锁者是否还活着，死了则接管
          try {
            const lockPid = Number((await readFile(lockFile, "utf8")).trim());
            process.kill(lockPid, 0);
            ctx.ui.notify(`maestro-mobile: 另一会话正在启动（pid=${lockPid}），本次跳过`, "warning");
            return;
          } catch {
            await unlink(lockFile).catch(() => { });
            await writeFile(lockFile, String(process.pid), { flag: "wx" });
            gotLock = true;
          }
        }
        const child = spawn(process.execPath, [hostCliPath(), "--port", String(port)], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, MAESTRO_MOBILE_PORT: String(port) },
        });
        child.unref();
        await writeFile(PID_FILE, String(child.pid ?? ""), "utf8");
        // 等待端口就绪（最多 3s）
        try {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 300));
            if (await probeHealth(port)) {
              ctx.ui.notify(`maestro-mobile: 已启动 :${port} pid=${child.pid}`, "info");
              void refreshStatus();
              return;
            }
          }
          ctx.ui.notify("maestro-mobile: 启动后 3s 内未见 health 通过，请查日志", "warning");
        } finally {
          await unlink(lockFile).catch(() => { }); // 释放竞争锁
        }
        return;
      }

      if (sub === "stop") {
        const pid = await readPid();
        if (!pid) {
          ctx.ui.notify("maestro-mobile: 无本扩展启动的实例（PID 文件不存在）；launchd/systemd 管理的实例请用对应服务命令停", "warning");
          return;
        }
        try {
          process.kill(pid, "SIGTERM");
          await unlink(PID_FILE).catch(() => { });
          ctx.ui.notify(`maestro-mobile: 已发送 SIGTERM 到 pid=${pid}`, "info");
        } catch {
          await unlink(PID_FILE).catch(() => { });
          ctx.ui.notify(`maestro-mobile: pid=${pid} 已不存在，清理 PID 文件`, "info");
        }
        void refreshStatus();
        return;
      }

      ctx.ui.notify(`maestro-mobile: 未知子命令 "${sub}"（可用：status / start / stop / qr）`, "warning");
    },
  });
}

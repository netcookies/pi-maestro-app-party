#!/usr/bin/env node
/**
 * ws-payload-relay.mjs — P0-4 实测：测量手机→host 的 WS 入站 payload 字节分布
 *
 * 原理：host 前挂一个纯转发代理。手机连 relay（Mac 局域网 IP:4738），
 * relay 带 token 转发到真实 host（127.0.0.1:4739）。所有帧原样透传，
 * 只记录「客户端→host」方向的每帧字节数、type、峰值；超限/断链如实记录。
 * host 侧 maxPayload=8MB 时，>8MB 的帧会被 host 以 1009 关闭 —— relay 会捕获。
 *
 * 用法：
 *   node scripts/ws-payload-relay.mjs [--listen 4738] [--target 127.0.0.1:4739] [--token <t>]
 *   token 省略时自动读 ~/.pi/maestro-mobile-token
 *
 * 手机侧：配对时把 host 地址改成 ws://<Mac IP>:4738（或直接改 App 持久化地址）。
 * 操作完成后 Ctrl-C，脚本打印汇总（各 type 峰值/均值、Top-5、8MB 距离）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
// host 依赖 ws@8（WebSocketServer）；仓库顶层 hoist 的是无关 ws@6，必须从 apps/host 解析
const here = dirname(fileURLToPath(import.meta.url));
let wsModule;
try { wsModule = require(join(here, "..", "apps", "host", "node_modules", "ws")); }
catch { wsModule = require("ws"); } // 回退：依赖已提升到顶层时
const { WebSocket, WebSocketServer } = wsModule;

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const LISTEN_PORT = Number(arg("listen", "4738"));
const [TARGET_HOST, TARGET_PORT] = (arg("target", "127.0.0.1:4739")).split(":");
let TOKEN = arg("token", "");
if (!TOKEN) {
  try { TOKEN = readFileSync(join(homedir(), ".pi", "maestro-mobile-token"), "utf8").trim(); } catch {}
}

const MB = 1024 * 1024;
const stats = new Map(); // type -> { n, max, sum, maxAt, closes }
let totalFrames = 0, peak = 0, peakType = "";

function record(dir, raw, note) {
  const bytes = raw.length;
  let type = "<unparsed>";
  try { type = JSON.parse(raw.toString()).type ?? "<no-type>"; } catch {}
  const key = `${dir}:${type}`;
  const s = stats.get(key) ?? { n: 0, max: 0, sum: 0, maxAt: 0 };
  s.n++; s.sum += bytes;
  if (bytes > s.max) { s.max = bytes; s.maxAt = Date.now(); }
  stats.set(key, s);
  if (dir === "up" && bytes > peak) { peak = bytes; peakType = type; }
  totalFrames++;
  const ts = new Date().toISOString().slice(11, 23);
  const flag = bytes > 4 * MB ? " ⚠️" : "";
  console.log(`[${ts}] ${dir} ${type} ${(bytes / 1024).toFixed(1)}KB${bytes > 1024 ? "" : ` (${bytes}B)`}${flag}${note ? " " + note : ""}`);
}

const wss = new WebSocketServer({ port: LISTEN_PORT, maxPayload: 64 * MB });
console.log(`relay :${LISTEN_PORT} -> ws://${TARGET_HOST}:${TARGET_PORT}/ws (token ${TOKEN ? "loaded" : "ABSENT — host 若开鉴权会 401"})`);
console.log(`host 上限参考: maxPayload=8MB。手机侧改连 ws://<本机 IP>:${LISTEN_PORT} 后开始操作。\n`);

wss.on("connection", (phone) => {
  console.log("— phone connected");
  const host = new WebSocket(`ws://${TARGET_HOST}:${TARGET_PORT}/ws?token=${encodeURIComponent(TOKEN)}`, { maxPayload: 64 * MB });
  let ready = false;
  const queue = [];
  host.on("open", () => { ready = true; for (const m of queue.splice(0)) host.send(m); });
  phone.on("message", (raw, isBinary) => { record("up", raw); if (ready) host.send(raw, { binary: isBinary }); else queue.push(raw); });
  host.on("message", (raw, isBinary) => { record("down", raw); if (phone.readyState === WebSocket.OPEN) phone.send(raw, { binary: isBinary }); });
  const teardown = (who) => (code, reason) => {
    console.log(`— ${who} closed code=${code} reason=${reason || "-"}`);
    if (who === "host" && (code === 1009 || code === 1008)) console.log("  ❗ host 因超限/鉴权主动断开：这就是 P0-4 要抓的信号");
    try { (who === "host" ? phone : host).close(code >= 1000 && code <= 1011 ? code : 1011); } catch {}
  };
  phone.on("close", teardown("phone")); host.on("close", teardown("host"));
  phone.on("error", (e) => console.log("phone error:", e.message));
  host.on("error", (e) => console.log("host error:", e.message));
});

function summary() {
  console.log("\n===== 汇总（up = 手机→host，P0-4 关注方向）=====");
  const rows = [...stats.entries()].sort((a, b) => b[1].max - a[1].max);
  for (const [key, s] of rows) {
    if (!key.startsWith("up:")) continue;
    console.log(`  ${key.slice(3).padEnd(22)} n=${String(s.n).padStart(4)} max=${(s.max / MB).toFixed(2)}MB avg=${(s.sum / s.n / 1024).toFixed(1)}KB`);
  }
  console.log(`\n  入站峰值: ${(peak / MB).toFixed(2)}MB (${peakType || "-"})  |  host 上限 8MB  |  余量 ${(8 - peak / MB).toFixed(2)}MB`);
  console.log(`  判定: ${peak === 0 ? "未捕获到入站帧——确认手机已连 relay 并触发 resume" : peak < 2 * MB ? "✅ 远低于 8MB，resume payload 无需改动" : peak < 6 * MB ? "⚠️ 偏大：建议加日志观察增长趋势" : "❌ 逼近 8MB：resume 需要分块或提高 maxPayload"}`);
  console.log(`  （出站 down 帧合计 ${totalFrames - [...stats.entries()].filter(([k]) => k.startsWith("up:")).reduce((a, [, s]) => a + s.n, 0)} 帧，含大 timeline，供参考）`);
}
process.on("SIGINT", () => { summary(); process.exit(0); });

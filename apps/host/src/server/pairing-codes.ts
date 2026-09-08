/**
 * pairing-codes — 扫码配对短码（文件态：~/.pi/maestro-mobile-pair-code.json，TTL 5 分钟）
 *
 * 跨进程共享：extension（qr 命令）写入，host（/api/pair-short）读取。
 */
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PairingInfoEntry {
  token: string;
  ips: string[];
  port: number;
}

const FILE = join(homedir(), ".pi", "maestro-mobile-pair-code.json");
const TTL_MS = 5 * 60_000;

export async function setPairingCode(code: string, entry: PairingInfoEntry): Promise<void> {
  // 文件内嵌 token → 0600（已存在时 mode 选项不生效，显式 chmod 收紧）
  await writeFile(FILE, JSON.stringify({ code, entry, at: Date.now() }), { encoding: "utf8", mode: 0o600 });
  await chmod(FILE, 0o600).catch(() => { });
}

export async function consumePairingCode(code: string): Promise<PairingInfoEntry | null> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as { code: string; entry: PairingInfoEntry; at: number };
    if (raw.code !== code || Date.now() - raw.at > TTL_MS) return null;
    return raw.entry;
  } catch {
    return null;
  }
}

export async function clearPairingCode(): Promise<void> {
  await unlink(FILE).catch(() => {});
}

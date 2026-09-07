/**
 * pairing — 配对码解析
 *
 * PC 端 `/maestro-mobile qr` 二维码内容（host 端默认输出裸 ws URL）：
 *   ws://<ip>:<port>/ws?token=<token>
 * 同时兼容 maestro-mobile://pair scheme（为未来 native 分享/深链预留）：
 *   maestro-mobile://pair?ws=ws://<ip>:<port>/ws&token=<token>
 */

export interface PairingInfo {
  /** WebSocket 地址（含 /ws 路径） */
  hostUrl: string;
  /** 可选 token（host 未启用鉴权时为空） */
  token?: string;
  /** 去掉 scheme 的展示地址 */
  displayHost: string;
}

export function extractPairing(raw: string): PairingInfo | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  // maestro-mobile://pair?ws=...&token=...
  if (text.startsWith("maestro-mobile://")) {
    try {
      const u = new URL(text.replace("maestro-mobile://", "maestro-mobile-pair://"));
      const ws = u.searchParams.get("ws");
      if (!ws) return null;
      const token = u.searchParams.get("token") ?? undefined;
      return normalize(ws, token);
    } catch {
      return null;
    }
  }

  // 裸 ws URL：ws://<ip>:<port>/ws?token=...
  if (/^wss?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      const token = u.searchParams.get("token") ?? undefined;
      // 重建不含 token 的 URL，token 走独立字段（连接时由 client 附加）
      u.searchParams.delete("token");
      return normalize(u.toString(), token);
    } catch {
      return null;
    }
  }

  return null;
}

function normalize(wsUrl: string, token?: string): PairingInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  return {
    hostUrl: parsed.toString(),
    token: token || undefined,
    displayHost: `${parsed.hostname}:${parsed.port || (parsed.protocol === "wss:" ? "443" : "80")}`,
  };
}

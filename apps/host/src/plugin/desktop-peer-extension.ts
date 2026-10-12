import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopPeerAccessDirection, DesktopPeerDelivery, DesktopPeerRequest, DesktopPeerResult } from "@maestro-mobile/shared";
import { DESKTOP_PEER_MAX_DEADLINE_MS, DESKTOP_PEER_MAX_PEERS, isDesktopPeerRequest } from "@maestro-mobile/shared";
import type { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";

/** Online inbox only: successful receipt means the target Plugin accepted the delivery into its local inbox. */
export function registerDesktopPeerCommand(pi: ExtensionAPI, getClient: () => DesktopPluginIpcClient | undefined) {
  const inbox = new Map<string, { delivery: DesktopPeerDelivery; timer: ReturnType<typeof setTimeout> }>();
  const display = (content: unknown): void => {
    pi.sendMessage({ customType: "desktop-peer", content: JSON.stringify(content, null, 2), display: true }, { triggerTurn: false });
  };

  pi.registerCommand("mb-peer", {
    description: 'Online Broker peer: list | candidates | access | revoke <grantId> | inbox | send {"target":{...},"message":"...","timeoutMs":30000}',
    handler: async (args, ctx) => {
      const space = args.indexOf(" ");
      const action = (space < 0 ? args : args.slice(0, space)).trim() || "list";
      const body = space < 0 ? "" : args.slice(space + 1).trim();
      try {
        if (action === "inbox") { display([...inbox.values()].map(({ delivery }) => delivery)); return; }
        if (action === "candidates") {
          const confirm = ctx.ui.confirm;
          if (!confirm || !(await confirm("显示未授权 peer", "仅显示在线 peer 的工作目录和精确目标，不会创建授权或发送消息。"))) return;
          const client = getClient();
          if (!client) throw new Error("disconnected");
          display(await client.requestPeers({ type: "desktop_peer_candidates", requestId: randomUUID(), deadlineAt: Date.now() + 2_000 }));
          return;
        }
        if (action === "access") {
          const client = getClient();
          if (!client) throw new Error("disconnected");
          display(await client.requestPeers({ type: "desktop_peer_access_list", requestId: randomUUID(), deadlineAt: Date.now() + 2_000 }));
          return;
        }
        if (action === "revoke") {
          if (!body) throw new Error("grant_id_required");
          const client = getClient();
          if (!client) throw new Error("disconnected");
          display(await client.requestPeers({ type: "desktop_peer_access_revoke", requestId: randomUUID(), deadlineAt: Date.now() + 2_000, grantId: body }));
          return;
        }
        if (action === "ack" || action === "reply") throw new Error("unknown_action");
        const requestId = randomUUID();
        let request: DesktopPeerRequest;
        if (action === "list") request = { type: "desktop_peer_list", requestId, deadlineAt: Date.now() + 2000 };
        else if (action === "send") {
          const input: unknown = JSON.parse(body);
          if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid_input");
          const data: Record<string, unknown> = { ...input };
          const timeoutMs = data.timeoutMs ?? DESKTOP_PEER_MAX_DEADLINE_MS;
          if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DESKTOP_PEER_MAX_DEADLINE_MS) throw new Error("invalid_timeout");
          const candidate = { type: "desktop_peer_send", requestId, deadlineAt: Date.now() + timeoutMs, target: data.target, message: data.message };
          if (!isDesktopPeerRequest(candidate)) throw new Error("invalid_message_or_target");
          request = candidate;
        } else throw new Error("unknown_action");
        const client = getClient();
        const result: DesktopPeerResult = client
          ? await client.requestPeers(request)
          : { type: "desktop_peer_result", requestId, status: "failed", error: { code: "disconnected" } };
        if (action === "send" && result.error?.code === "authorization_required" && result.authorization) {
          const confirm = ctx.ui.confirm;
          const approved = confirm ? await confirm("跨工作目录授权", `允许 ${result.authorization.sourceCwd} 向 ${result.authorization.targetCwd} 发送 peer 消息？`) : false;
          if (!approved) { ctx.ui.notify("未创建跨 cwd 授权；消息未发送，请重新执行命令。", "info"); return; }
          let direction: DesktopPeerAccessDirection = "one_way";
          if (ctx.ui.select) {
            const selected = await ctx.ui.select("授权方向", ["仅允许当前方向", "允许双向"]);
            if (!selected) { ctx.ui.notify("未创建跨 cwd 授权；消息未发送。", "info"); return; }
            direction = selected === "允许双向" ? "bidirectional" : "one_way";
          }
          const grant = await client?.requestPeers({ type: "desktop_peer_access_grant", requestId: randomUUID(), deadlineAt: Date.now() + 2_000, target: (request as Extract<DesktopPeerRequest, { type: "desktop_peer_send" }>).target, direction });
          display(grant ?? { type: "desktop_peer_result", requestId, status: "failed", error: { code: "disconnected" } });
          ctx.ui.notify(grant?.status === "access_granted" ? "授权已保存；请重新执行 /mb-peer send。" : "授权未保存，消息未发送。", grant?.status === "access_granted" ? "info" : "warning");
          return;
        }
        display(result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "desktop messaging failed", "error");
      }
    },
  });

  return {
    receive(delivery: DesktopPeerDelivery): Promise<void> {
      if (inbox.size >= DESKTOP_PEER_MAX_PEERS || inbox.has(delivery.deliveryId) || delivery.deadlineAt <= Date.now()) return Promise.reject(new Error("inbox_unavailable"));
      const timer = setTimeout(() => inbox.delete(delivery.deliveryId), Math.max(1, delivery.deadlineAt - Date.now()));
      inbox.set(delivery.deliveryId, { delivery, timer });
      try { display(delivery); } catch { /* The queued delivery remains available through /mb-peer inbox. */ }
      return Promise.resolve();
    },
    clear(): void {
      for (const pending of inbox.values()) clearTimeout(pending.timer);
      inbox.clear();
    },
  };
}

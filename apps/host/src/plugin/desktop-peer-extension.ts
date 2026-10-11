import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopPeerDelivery, DesktopPeerReply, DesktopPeerRequest, DesktopPeerResult } from "@maestro-mobile/shared";
import { DESKTOP_PEER_MAX_DEADLINE_MS, DESKTOP_PEER_MAX_PEERS, isDesktopPeerRequest } from "@maestro-mobile/shared";
import type { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";

/** Online inbox only: a receipt requires the target's explicit ack command. */
export function registerDesktopPeerCommand(pi: ExtensionAPI, getClient: () => DesktopPluginIpcClient | undefined) {
  const inbox = new Map<string, { delivery: DesktopPeerDelivery; acknowledge: () => void; reject: () => void }>();
  const display = (content: unknown): void => {
    pi.sendMessage({ customType: "desktop-peer", content: JSON.stringify(content, null, 2), display: true }, { triggerTurn: false });
  };

  pi.registerCommand("desktop-message", {
    description: 'Online Broker messaging: list | inbox | ack <deliveryId> | reply <deliveryId> <message> | send {"target":{...},"message":"...","timeoutMs":30000}',
    handler: async (args, ctx) => {
      const space = args.indexOf(" ");
      const action = (space < 0 ? args : args.slice(0, space)).trim() || "list";
      const body = space < 0 ? "" : args.slice(space + 1).trim();
      try {
        if (action === "inbox") { display([...inbox.values()].map(({ delivery }) => delivery)); return; }
        if (action === "ack") {
          const pending = inbox.get(body);
          if (!pending || pending.delivery.deadlineAt <= Date.now()) throw new Error("delivery_unavailable");
          pending.acknowledge();
          display({ status: "acknowledged", deliveryId: body });
          return;
        }
        if (action === "reply") {
          const split = body.indexOf(" ");
          if (split <= 0) throw new Error("invalid_reply");
          const deliveryId = body.slice(0, split);
          const message = body.slice(split + 1);
          const pending = inbox.get(deliveryId);
          if (!pending || pending.delivery.deadlineAt <= Date.now()) throw new Error("delivery_unavailable");
          if (!isDesktopPeerRequest({ type: "desktop_peer_send", requestId: "reply", deadlineAt: Date.now() + 1_000, target: pending.delivery.source, message })) throw new Error("invalid_reply");
          const client = getClient();
          if (!client) throw new Error("disconnected");
          if (!client.sendPeerReply({ type: "desktop_peer_reply", deliveryId, replyId: randomUUID(), message })) throw new Error("reply_not_queued");
          pending.acknowledge();
          display({ status: "reply_sent", deliveryId });
          return;
        }
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
        display(result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "desktop messaging failed", "error");
      }
    },
  });

  return {
    receive(delivery: DesktopPeerDelivery): Promise<void> {
      if (inbox.size >= DESKTOP_PEER_MAX_PEERS || inbox.has(delivery.deliveryId) || delivery.deadlineAt <= Date.now()) return Promise.reject(new Error("inbox_unavailable"));
      return new Promise<void>((resolve, reject) => {
        const finish = (accepted: boolean) => {
          clearTimeout(timer);
          inbox.delete(delivery.deliveryId);
          if (accepted) resolve(); else reject(new Error("delivery_unavailable"));
        };
        const timer = setTimeout(() => finish(false), Math.max(1, delivery.deadlineAt - Date.now()));
        inbox.set(delivery.deliveryId, { delivery, acknowledge: () => finish(true), reject: () => finish(false) });
        try { display(delivery); } catch { /* /desktop-message inbox still exposes the authoritative pending delivery. */ }
      });
    },
    onReply(reply: DesktopPeerReply): void {
      display(reply);
    },
    clear(): void {
      for (const pending of inbox.values()) pending.reject();
      inbox.clear();
    },
  };
}

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopPeerAccessDirection, DesktopPeerDelivery, DesktopPeerRequest, DesktopPeerResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DESKTOP_PEER_MAX_DEADLINE_MS, DESKTOP_PEER_MAX_PEERS, isDesktopPeerRequest } from "@maestro-mobile/shared";
import type { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";

/** Online inbox only: successful receipt means the target Plugin accepted the delivery into its local inbox. */
export function registerDesktopPeerCommand(pi: ExtensionAPI, getClient: () => DesktopPluginIpcClient | undefined) {
  const inbox = new Map<string, { delivery: DesktopPeerDelivery; timer: ReturnType<typeof setTimeout> }>();
  let generation = 0;
  const peerLabel = (peer: DesktopPluginTarget): string => `${peer.sessionId.slice(0, 6)} · ${peer.normalizedCwd}`;
  const listPeers = async () => {
    const client = getClient();
    const currentGeneration = generation;
    if (!client) throw new Error("disconnected");
    const result = await client.requestPeers({ type: "desktop_peer_list", requestId: randomUUID(), deadlineAt: Date.now() + 2_000 });
    if (client !== getClient() || currentGeneration !== generation) throw new Error("disconnected");
    if (result.status !== "listed") throw new Error(result.error?.code ?? "peer_list_failed");
    if (result.truncated) throw new Error("peer_list_truncated: 在线会话列表超出上限，暂无法唯一解析目标。");
    return { client, generation: currentGeneration, peers: result.peers ?? [] };
  };
  const listAccess = async () => {
    const client = getClient();
    const currentGeneration = generation;
    if (!client) throw new Error("disconnected");
    const result = await client.requestPeers({ type: "desktop_peer_access_list", requestId: randomUUID(), deadlineAt: Date.now() + 2_000 });
    if (client !== getClient() || currentGeneration !== generation) throw new Error("disconnected");
    if (result.status !== "access_listed") throw new Error(result.error?.code ?? "peer_access_list_failed");
    if (result.truncated) throw new Error("peer_list_truncated: 在线会话列表超出上限，暂无法唯一解析目标。");
    return { client, generation: currentGeneration, peers: result.peers ?? [], grants: result.grants ?? [] };
  };
  const display = (content: unknown): void => {
    pi.sendMessage({ customType: "desktop-peer", content: JSON.stringify(content, null, 2), display: true }, { triggerTurn: false });
  };

  pi.registerCommand("mb-peer", {
    description: "Online Broker peer: send <sessionId|短 ID> <消息> | list | access | revoke <grantId> | inbox",
    getArgumentCompletions: async (prefix) => {
      const normalized = prefix.trimStart();
      const sendMatch = /^send\s+([^\s]*)$/.exec(normalized);
      if (sendMatch) {
        if (sendMatch[1]!.startsWith("{")) return null;
        try {
          const { peers } = await listPeers();
          return peers.filter((peer) => peer.sessionId.startsWith(sendMatch[1]!)).map((peer) => ({
            value: `send ${peer.sessionId} `,
            label: peerLabel(peer),
            description: `${peer.sessionId} · ${peer.endpointId} · ${peer.processGeneration}`,
          }));
        } catch { return null; }
      }
      const accessMatch = /^access\s+([^\s]*)$/.exec(normalized);
      if (accessMatch) {
        try {
          const { peers, client } = await listAccess();
          return peers.filter((peer) => peer.normalizedCwd !== client.target.normalizedCwd && peer.sessionId.startsWith(accessMatch[1]!)).map((peer) => ({
            value: `access ${peer.sessionId} `,
            label: peerLabel(peer),
            description: `${peer.sessionId} · ${peer.endpointId} · ${peer.processGeneration}`,
          }));
        } catch { return null; }
      }
      const revokeMatch = /^revoke\s+([^\s]*)$/.exec(normalized);
      if (revokeMatch) {
        try {
          const { grants, client } = await listAccess();
          return grants.filter((grant) => !grant.managed && grant.sourceCwd === client.target.normalizedCwd
            && grant.grantId.startsWith(revokeMatch[1]!)).map((grant) => ({
            value: `revoke ${grant.grantId}`,
            label: `${grant.grantId.slice(0, 8)} · ${grant.sourceCwd} → ${grant.targetCwd}`,
            description: `${grant.grantId} · ${grant.direction}${grant.managed ? " · managed" : ""}`,
          }));
        } catch { return null; }
      }
      const actions = ["list", "send ", "access", "revoke ", "inbox"];
      return actions.filter((action) => action.startsWith(normalized)).map((action) => ({ value: action, label: action.trim() }));
    },
    handler: async (args, ctx) => {
      args = args.trimStart();
      const space = args.search(/\s/);
      const action = (space < 0 ? args : args.slice(0, space)).trim() || "list";
      const body = space < 0 ? "" : args.slice(space + 1).trim();
      try {
        if (action === "inbox") { display([...inbox.values()].map(({ delivery }) => delivery)); return; }
        if (action === "access") {
          const access = await listAccess();
          if (!body) { display({ peers: access.peers, grants: access.grants }); return; }
          const matches = access.peers.filter((peer) => peer.normalizedCwd !== access.client.target.normalizedCwd && (peer.sessionId === body || peer.sessionId.startsWith(body)));
          if (!matches.length) throw new Error("peer_not_found: 请用 /mb-peer access 查看在线会话。");
          let target = matches[0]!;
          if (matches.length > 1) {
            if (!ctx.ui.select) throw new Error("ambiguous_peer: 请使用完整 sessionId；同一会话有多个 endpoint 时需交互选择。");
            const labels = matches.map((peer) => `${peerLabel(peer)} · ${peer.sessionId} · ${peer.endpointId} · ${peer.processGeneration}`);
            const selected = await ctx.ui.select("选择授权 peer", labels);
            if (!selected) return;
            const index = labels.indexOf(selected);
            if (index < 0) throw new Error("invalid_peer_selection");
            target = matches[index]!;
          }
          if (!ctx.ui.select) throw new Error("authorization_direction_required");
          const selected = await ctx.ui.select("授权方向", ["仅允许当前方向", "允许双向"]);
          if (!selected) return;
          const direction: DesktopPeerAccessDirection = selected === "允许双向" ? "bidirectional" : "one_way";
          if (access.client !== getClient() || access.generation !== generation) throw new Error("disconnected");
          display(await access.client.requestPeers({ type: "desktop_peer_access_grant", requestId: randomUUID(), deadlineAt: Date.now() + 2_000, target, direction }));
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
        let resolved: Awaited<ReturnType<typeof listPeers>> | undefined;
        if (action === "list") request = { type: "desktop_peer_list", requestId, deadlineAt: Date.now() + 2000 };
        else if (action === "send") {
          const match = /^(\S+)\s+([\s\S]+)$/.exec(body);
          if (!match || body.startsWith("{")) throw new Error("用法：/mb-peer send <sessionId 或短 ID> <消息内容>");
          const selector = match[1]!;
          const message = match[2]!;
          resolved = await listPeers();
          const findMatches = (peers: DesktopPluginTarget[]) => {
            const exact = peers.filter((peer) => peer.sessionId === selector);
            return exact.length ? exact : peers.filter((peer) => peer.sessionId.startsWith(selector));
          };
          let matches = findMatches(resolved.peers);
          if (!matches.length && ctx.ui.confirm && await ctx.ui.confirm("显示未授权 peer", "是否查找未授权的在线 peer？请改用 /mb-peer access 查看所有在线会话。")) {
            if (resolved.client !== getClient() || resolved.generation !== generation) throw new Error("disconnected");
            const { peers } = await listAccess();
            matches = findMatches(peers);
          }
          if (!matches.length) throw new Error("peer_not_found: 请用 /mb-peer list 查看可发送会话；其他在线会话请用 /mb-peer access。");
          let target = matches[0]!;
          if (matches.length > 1) {
            if (!ctx.ui.select) throw new Error("ambiguous_peer: 请使用完整 sessionId；同一会话有多个 endpoint 时需交互选择。");
            const labels = matches.map((peer, index) => `${index + 1}. ${peerLabel(peer)} · ${peer.sessionId} · ${peer.endpointId} · ${peer.processGeneration}`);
            const selected = await ctx.ui.select("选择 peer 目标", labels);
            if (!selected) return;
            const index = labels.indexOf(selected);
            if (index < 0) throw new Error("invalid_peer_selection");
            target = matches[index]!;
          }
          const candidate = { type: "desktop_peer_send", requestId, deadlineAt: Date.now() + DESKTOP_PEER_MAX_DEADLINE_MS, target, message };
          if (!isDesktopPeerRequest(candidate)) throw new Error("invalid_message_or_target");
          request = candidate;
        } else throw new Error("unknown_action");
        const client = getClient();
        if (resolved && (resolved.client !== client || resolved.generation !== generation)) throw new Error("disconnected");
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
          if (resolved && (resolved.client !== getClient() || resolved.generation !== generation)) throw new Error("disconnected");
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
      generation += 1;
      for (const pending of inbox.values()) clearTimeout(pending.timer);
      inbox.clear();
    },
  };
}

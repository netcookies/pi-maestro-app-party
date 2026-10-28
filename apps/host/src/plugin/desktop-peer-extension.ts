import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Text, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopPeerAccessDirection, DesktopPeerDelivery, DesktopPeerRequest, DesktopPeerResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { DESKTOP_PEER_MAX_DEADLINE_MS, DESKTOP_PEER_MAX_PEERS, isDesktopPeerRequest } from "@maestro-mobile/shared";
import type { DesktopPluginIpcClient } from "./desktop-plugin-ipc.js";

/** Online inbox only: successful receipt means the target Plugin accepted the delivery into its local inbox. */
export function registerDesktopPeerCommand(
  pi: ExtensionAPI,
  getClient: () => DesktopPluginIpcClient | undefined,
  options: { delegationDirectory?: string } = {},
) {
  const inbox = new Map<string, { delivery: DesktopPeerDelivery; timer: ReturnType<typeof setTimeout>; generation: number }>();
  const consumedDeliveryIds = new Set<string>();
  let peerTurnGate: { deliveryId: string; generation: number; delegated: boolean; allowedToolCallId?: string; approvalInFlight: boolean; blocked: boolean } | undefined;
  let gateHandlersRegistered = false;
  const delegationDirectory = options.delegationDirectory ?? join(homedir(), ".pi", "maestro-mobile", "peer-delegations");
  let generation = 0;
  const delegationPath = (sessionId: string): string => join(delegationDirectory, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  const readDelegations = async (): Promise<string[]> => {
    let files: string[];
    try { files = await readdir(delegationDirectory); } catch { return []; }
    const sessionIds: string[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      try {
        const data = JSON.parse(await readFile(join(delegationDirectory, file), "utf8")) as { sessionId?: unknown };
        if (typeof data.sessionId === "string" && data.sessionId && delegationPath(data.sessionId).split(/[\\/]/u).at(-1) === file) sessionIds.push(data.sessionId);
      } catch { /* Ignore a corrupt or concurrently removed preference. */ }
    }
    return sessionIds.sort();
  };
  const setDelegation = async (sessionId: string, allowed: boolean): Promise<void> => {
    const path = delegationPath(sessionId);
    if (!allowed) { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); return; }
    await mkdir(delegationDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ sessionId, createdAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  };
  const formatCwd = (cwd: string): string => {
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3) return cwd;
    const root = cwd.startsWith("/") ? "/" : "";
    return `${root}${parts[0]}/.../${parts.at(-1)}`;
  };
  const peerLabel = (peer: DesktopPluginTarget): string => `${peer.sessionId} · ${formatCwd(peer.normalizedCwd)}`;
  const peerDescription = (peer: DesktopPluginTarget): string => `cwd=${formatCwd(peer.normalizedCwd)} · endpoint=${peer.endpointId} · generation=${peer.processGeneration}`;
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
    pi.sendMessage({ customType: "mb-peer", content: typeof content === "string" ? content : JSON.stringify(content, null, 2), display: true }, { triggerTurn: false });
  };

  const peerMessage = (direction: "in" | "out", peer: DesktopPluginTarget, message: string): string => {
    const marker = direction === "in" ? "←" : "→";
    const verb = direction === "in" ? "来自" : "发给";
    return `${marker} ${verb} peer ${peer.sessionId.slice(0, 8)}\n${message}`;
  };

  pi.registerMessageRenderer("mb-peer", (message, _options, theme): Component => {
    const details = message.details as { direction?: "in" | "out"; peer?: DesktopPluginTarget; body?: string } | undefined;
    const visible = details?.peer && details.body !== undefined
      ? peerMessage(details.direction === "out" ? "out" : "in", details.peer, details.body)
      : typeof message.content === "string" ? message.content : "";
    const [heading = "mb-peer", ...body] = visible.split("\n");
    const direction = details?.direction === "out" ? "out" : "in";
    const source = details?.peer
      ? `${direction === "out" ? "发给" : "来自"} peer ${details.peer.sessionId.slice(0, 8)}`
      : heading.replace(/^[←→]\s*/u, "");
    const messageBody = details?.body !== undefined ? details.body.split("\n") : body;

    return {
      render(width) {
        if (width < 5) return new Text(visible, 0, 0).render(width);

        const border = (text: string) => theme.fg("dim", text);
        const innerWidth = width - 2;
        const contentWidth = Math.max(1, width - 4);
        const icon = theme.fg("success", direction === "out" ? "→" : "←");
        const label = theme.fg("warning", theme.bold("mb-peer"));
        const peerSource = theme.fg("accent", source);
        const styledHeader = `${icon}  ${label}  ${peerSource}`;
        const header = truncateToWidth(` ${styledHeader} `, innerWidth - 1, "…");
        const topPrefix = `─${header}`;
        const topFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(topPrefix)));
        const fit = (line: string): string => {
          const clipped = truncateToWidth(line, contentWidth, "…");
          return `${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}`;
        };
        const lines = messageBody.flatMap((line) => wrapTextWithAnsi(line || " ", contentWidth));

        return [
          `${border("╭")}${border(topPrefix)}${border(topFill)}${border("╮")}`,
          ...lines.map((line) => `${border("│")} ${theme.fg("text", fit(line))} ${border("│")}`),
          `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
        ];
      },
      invalidate() {},
    };
  });

  const sendToTarget = async (selector: string, message: string) => {
    if (!selector.trim() || !message.trim()) throw new Error("target_and_message_required");
    const resolved = await listPeers();
    const exact = resolved.peers.filter((peer) => peer.sessionId === selector);
    const matches = exact.length ? exact : resolved.peers.filter((peer) => peer.sessionId.startsWith(selector));
    if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_peer: use the full sessionId" : "peer_not_found: use /mb-peer access to discover other workspaces");
    const target = matches[0]!;
    const candidate = { type: "desktop_peer_send", requestId: randomUUID(), deadlineAt: Date.now() + DESKTOP_PEER_MAX_DEADLINE_MS, target, message };
    if (!isDesktopPeerRequest(candidate)) throw new Error("invalid_message_or_target");
    if (resolved.client !== getClient() || resolved.generation !== generation) throw new Error("disconnected");
    return { ...resolved, target, request: candidate };
  };
  const sendDisplay = (result: DesktopPeerResult, target?: DesktopPluginTarget, message?: string): void => {
    if (result.status !== "accepted" || !target || message === undefined) return;
    pi.sendMessage({
      customType: "mb-peer",
      content: peerMessage("out", target, message),
      display: true,
      details: { direction: "out", peer: target, body: message },
    }, { triggerTurn: false });
  };
  const toolResult = (text: string, isError = false) => ({
    content: [{ type: "text" as const, text }],
    details: { status: isError ? "error" : "ok" },
    ...(isError ? { isError: true } : {}),
  });
  const gateToolCall = async (event: { toolName: string; toolCallId: string; input: unknown }, ctx: { ui: { confirm?: (title: string, message: string) => Promise<boolean> } }) => {
    if (event.toolName === "ask-user-question") return;
    const pending = [...inbox.values()];
    const gate = peerTurnGate;
    if (!gate) return;
    if (gate.blocked || gate.approvalInFlight || (gate.allowedToolCallId && gate.allowedToolCallId !== event.toolCallId)) return { block: true, reason: "Peer request is already settled; this tool call is not approved for the exact request." };
    if (pending.length !== 1 || pending[0]!.delivery.deliveryId !== gate.deliveryId || pending[0]!.generation !== gate.generation) {
      gate.blocked = true;
      return { block: true, reason: "Peer approval is ambiguous or stale; no tool call is authorized." };
    }
    const entry = pending[0]!;
    if (gate.delegated) {
      // 已在委托记录中记住的 peer：本会话内后续转发自动放行，无需重复人工确认
      clearTimeout(entry.timer);
      inbox.delete(entry.delivery.deliveryId);
      consumedDeliveryIds.add(entry.delivery.deliveryId);
      gate.allowedToolCallId = event.toolCallId;
      return;
    }
    // 未记住的 peer：同步置位，防并发重入
    gate.approvalInFlight = true;
    const approvalMessage = `Local approval is required for this exact peer request and tool call.\nPeer: ${entry.delivery.source.sessionId} / ${entry.delivery.source.endpointId} / ${entry.delivery.source.normalizedCwd} / ${entry.delivery.source.processGeneration}\nRequest: ${entry.delivery.message}\nTool call: ${event.toolName}\nInput: ${JSON.stringify(event.input)}`;
    let approved = false;
    try { approved = typeof ctx.ui.confirm === "function" ? await ctx.ui.confirm(`Peer request ${entry.delivery.deliveryId}`, approvalMessage) : false; } catch { approved = false; }
    gate.approvalInFlight = false;
    clearTimeout(entry.timer);
    inbox.delete(entry.delivery.deliveryId);
    consumedDeliveryIds.add(entry.delivery.deliveryId);
    if (!approved) { gate.blocked = true; return { block: true, reason: `Local approval denied for peer request ${entry.delivery.deliveryId}.` }; }
    gate.allowedToolCallId = event.toolCallId;
  };
  const enableGateHandlers = (): void => {
    if (gateHandlersRegistered) return;
    gateHandlersRegistered = true;
    pi.on("tool_call", gateToolCall as never);
    pi.on("turn_end", () => { peerTurnGate = undefined; });
    pi.on("agent_end", () => { peerTurnGate = undefined; });
  };

  pi.registerTool({
    name: "mb-peer",
    label: "MB Peer",
    description: "Discover online peers or send collaboration messages. Unremembered peer requests require explicit local user approval via ask-user-question before executing actions. Once remembered via action=remember (or /mb-peer delegate remember), subsequent requests from that peer within the session are automatically authorized.",
    promptSnippet: "Send and receive collaboration messages with online Pi peers via mb-peer.",
    renderShell: "self",
    renderCall: (args, theme) => new Text(theme.fg("toolTitle", `mb-peer · ${args.action === "send" ? `发送给 ${args.target?.slice(0, 8) ?? "peer"}` : "查看在线 peer"}`), 0, 0),
    renderResult: (result, _options, theme, context) => {
      const failed = (result.details as { status?: string } | undefined)?.status === "error";
      const content = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      const text = failed ? `mb-peer · 失败：${content}` : context.args.action === "send" ? "mb-peer · 已接收" : "mb-peer · peer 列表已更新";
      return new Text(theme.fg(failed ? "error" : "success", text), 0, 0);
    },
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("send"), Type.Literal("delegations"), Type.Literal("remember"), Type.Literal("forget")]),
      target: Type.Optional(Type.String({ minLength: 1, description: "Exact sessionId or an unambiguous prefix; required for send, remember, and forget." })),
      message: Type.Optional(Type.String({ minLength: 1, description: "Message text; required for send." })),
    }),
    async execute(_id, params) {
      try {
        if (params.action === "list") {
          const { peers, client } = await listAccess();
          const remote = peers.filter((peer) => peer.normalizedCwd !== client.target.normalizedCwd);
          return toolResult(JSON.stringify(remote.map((peer) => ({ sessionId: peer.sessionId, cwd: formatCwd(peer.normalizedCwd), endpointId: peer.endpointId, processGeneration: peer.processGeneration }))));
        }
        if (params.action === "delegations") return toolResult(JSON.stringify(await readDelegations()));
        if (params.action === "remember" || params.action === "forget") {
          if (!params.target?.trim()) throw new Error("target_session_id_required");
          const sessionIds = params.action === "forget" ? await readDelegations() : (await listPeers()).peers.map((peer) => peer.sessionId);
          const exact = sessionIds.filter((sessionId) => sessionId === params.target);
          const matches = exact.length ? exact : sessionIds.filter((sessionId) => sessionId.startsWith(params.target!));
          if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_peer: use the full sessionId" : "peer_not_found");
          await setDelegation(matches[0]!, params.action === "remember");
          return toolResult(params.action === "remember" ? "delegation_remembered" : "delegation_forgotten");
        }
        if (!params.target || !params.message) throw new Error("target_and_message_required");
        const result = await sendToTarget(params.target, params.message);
        const receipt = await result.client.requestPeers(result.request);
        sendDisplay(receipt, result.target, params.message);
        if (receipt.status !== "accepted") return toolResult(receipt.error?.code ?? receipt.status, true);
        return {
          content: [{ type: "text" as const, text: "accepted" }],
          details: { status: receipt.status, deliveryId: receipt.deliveryId, target: result.target.sessionId },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult(message, true);
      }
    },
  });

  pi.registerCommand("mb-peer", {
    description: "Online Broker peer: send <sessionId|短 ID> <消息> | list | access | revoke <grantId> | delegate list|remember <sessionId>|forget <sessionId> | inbox",
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
            description: peerDescription(peer),
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
            description: peerDescription(peer),
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
        if (action === "delegate") {
          if (!body || body === "list") { display({ delegatedPeerSessionIds: await readDelegations() }); return; }
          const match = /^(remember|forget)\s+(\S+)$/u.exec(body);
          if (!match) throw new Error("用法：/mb-peer delegate list|remember <sessionId>|forget <sessionId>");
          const sessionIds = match[1] === "forget" ? await readDelegations() : (await listPeers()).peers.map((peer) => peer.sessionId);
          const exact = sessionIds.filter((sessionId) => sessionId === match[2]);
          const matches = exact.length ? exact : sessionIds.filter((sessionId) => sessionId.startsWith(match[2]!));
          if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_peer: 请使用完整 sessionId" : "peer_not_found");
          await setDelegation(matches[0]!, match[1] === "remember");
          display({ status: match[1] === "remember" ? "delegation_remembered" : "delegation_forgotten", sessionId: matches[0]! });
          return;
        }
        if (action === "inbox") { display([...inbox.values()].map(({ delivery }) => delivery)); return; }
        if (action === "access") {
          const access = await listAccess();
          if (!body) {
            const peers = access.peers.filter((peer) => peer.normalizedCwd !== access.client.target.normalizedCwd);
            display({ peers: peers.map((peer) => ({ ...peer, displayCwd: formatCwd(peer.normalizedCwd) })), grants: access.grants });
            return;
          }
          const matches = access.peers.filter((peer) => peer.normalizedCwd !== access.client.target.normalizedCwd && (peer.sessionId === body || peer.sessionId.startsWith(body)));
          if (!matches.length) throw new Error("peer_not_found: 请用 /mb-peer access 查看在线会话。");
          let target = matches[0]!;
          if (matches.length > 1) {
            if (!ctx.ui.select) throw new Error("ambiguous_peer: 请使用完整 sessionId；同一会话有多个 endpoint 时需交互选择。");
            const labels = matches.map((peer) => `${peerLabel(peer)} · ${peerDescription(peer)}`);
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
            const labels = matches.map((peer, index) => `${index + 1}. ${peerLabel(peer)} · ${peerDescription(peer)}`);
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
        if (action === "send" && result.status === "accepted") sendDisplay(result, (request as Extract<DesktopPeerRequest, { type: "desktop_peer_send" }>).target, (request as Extract<DesktopPeerRequest, { type: "desktop_peer_send" }>).message);
        else if (action === "send") ctx.ui.notify(result.error?.code ?? result.status, "error");
        else display(result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "desktop messaging failed", "error");
      }
    },
  });

  return {
    async receive(delivery: DesktopPeerDelivery): Promise<void> {
      if (inbox.size >= DESKTOP_PEER_MAX_PEERS || inbox.has(delivery.deliveryId) || consumedDeliveryIds.has(delivery.deliveryId) || delivery.deadlineAt <= Date.now()) return Promise.reject(new Error("inbox_unavailable"));
      const generationAtReceive = generation;
      const timer = setTimeout(() => inbox.delete(delivery.deliveryId), Math.max(1, delivery.deadlineAt - Date.now()));
      inbox.set(delivery.deliveryId, { delivery, timer, generation: generationAtReceive });
      try {
        enableGateHandlers();
        const delegatedSessionIds = await readDelegations();
        const delegated = delegatedSessionIds.includes(delivery.source.sessionId);
        if (!peerTurnGate) peerTurnGate = { deliveryId: delivery.deliveryId, generation: generationAtReceive, delegated, approvalInFlight: false, blocked: false };
        else peerTurnGate.delegated = delegated;
        const content = `${peerMessage("in", delivery.source, delivery.message)}\n\n${delegated
          ? "该 peer 在本会话内已被记住并授权，后续协作动作已自动放行。"
          : "这是尚未记住的 peer/session。在执行任何实际动作前，必须先调用 ask-user-question 询问本机用户获得明确授权（选项：同意本次执行、授权本会话、拒绝）。若用户选择「授权本会话」，请调用 mb-peer tool（action=remember，target=" + delivery.source.sessionId + "），后续请求将自动放行。"}\n回复可调用 mb-peer tool：action=send，target=${delivery.source.sessionId}。`;
        pi.sendMessage({ customType: "mb-peer", content, display: true, details: { direction: "in", peer: delivery.source, body: delivery.message } }, { triggerTurn: true, deliverAs: "steer" });
      } catch { /* The queued delivery remains available through /mb-peer inbox. */ }
      return Promise.resolve();
    },
    clear(): void {
      generation += 1;
      for (const pending of inbox.values()) {
        clearTimeout(pending.timer);
        consumedDeliveryIds.add(pending.delivery.deliveryId);
      }
      inbox.clear();
      peerTurnGate = undefined;
    },
  };
}

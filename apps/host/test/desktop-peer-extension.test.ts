import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { DESKTOP_PEER_MAX_PEERS } from "@maestro-mobile/shared";
import type { DesktopPeerDelivery, DesktopPeerRequest, DesktopPeerResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { registerDesktopPeerCommand } from "../src/plugin/desktop-peer-extension.js";
import type { DesktopPluginIpcClient } from "../src/plugin/desktop-plugin-ipc.js";

const target: DesktopPluginTarget = { sessionId: "peer", endpointId: "endpoint", normalizedCwd: "/another", processGeneration: "generation" };

function setup(result: (request: DesktopPeerRequest) => DesktopPeerResult | Promise<DesktopPeerResult>) {
  let handler: (args: string, ctx: unknown) => Promise<void> = async () => undefined;
  let complete: NonNullable<RegisteredCommand["getArgumentCompletions"]> = () => null;
  const messages: unknown[] = [];
  const requests: DesktopPeerRequest[] = [];
  let commandName = "";
  const pi = {
    registerCommand: (name: string, _command: { handler: typeof handler; getArgumentCompletions: typeof complete }) => {
      commandName = name; handler = _command.handler; complete = _command.getArgumentCompletions;
    },
    sendMessage: (message: unknown) => messages.push(message),
  };
  const client = { requestPeers: async (request: DesktopPeerRequest) => { requests.push(request); return result(request); } };
  let connected = true;
  const peerCommand = registerDesktopPeerCommand(pi as unknown as ExtensionAPI, () => connected ? client as unknown as DesktopPluginIpcClient : undefined);
  const notify = vi.fn();
  const run = async (command: string, confirm?: (title: string, message: string) => Promise<boolean>, select?: (title: string, options: string[]) => Promise<string | undefined>) =>
    handler(command, { ui: { notify, confirm, select } });
  return { run, requests, messages, notify, peerCommand, complete: (prefix: string) => complete(prefix), disconnect: () => { connected = false; peerCommand.clear(); }, get commandName() { return commandName; } };
}

describe("desktop peer target input and completion", () => {
  const peer = { ...target, sessionId: "39a52f00-1111-2222-3333-444444444444" };
  const other = { ...peer, sessionId: "39a52f11-1111-2222-3333-444444444444", normalizedCwd: "/work/other" };
  const respond = (peers: DesktopPluginTarget[]) => (request: DesktopPeerRequest): DesktopPeerResult => request.type === "desktop_peer_list"
    ? { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers }
    : { type: "desktop_peer_result", requestId: request.requestId, status: "accepted", deliveryId: "delivery" };

  it("resolves short/full IDs to the exact four fields", async () => {
    const state = setup(respond([peer]));
    await state.run("send 39a52f 你好 world\n第二行");
    await state.run(`send ${peer.sessionId} full ID`);
    expect(state.requests.map((request) => request.type)).toEqual([
      "desktop_peer_list", "desktop_peer_send", "desktop_peer_list", "desktop_peer_send",
    ]);
    expect(state.requests.filter((request) => request.type === "desktop_peer_send")).toMatchObject([
      { target: peer, message: "你好 world\n第二行" }, { target: peer, message: "full ID" },
    ]);
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("queries fresh sendable peers for completion and stops completing inside the message or JSON", async () => {
    let peers = [peer];
    const state = setup((request) => respond(peers)(request));
    expect(await state.complete("s")).toContainEqual({ value: "send ", label: "send" });
    expect(state.requests).toHaveLength(0);
    expect(await state.complete("send 39")).toEqual([{
      value: `send ${peer.sessionId} `, label: `39a52f · ${peer.normalizedCwd}`,
      description: `${peer.sessionId} · ${peer.endpointId} · ${peer.processGeneration}`,
    }]);
    peers = [other];
    expect(await state.complete("send ")).toMatchObject([{ value: `send ${other.sessionId} `, label: "39a52f · /work/other" }]);
    expect(await state.complete("send unknown")).toEqual([]);
    expect(await state.complete("send 39a52f message")).toEqual([]);
    expect(await state.complete('send {"target":')).toBeNull();
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_list", "desktop_peer_list"]);
  });

  it("disambiguates colliding prefixes and prefers an exact session ID match", async () => {
    const state = setup(respond([peer, other]));
    const select = vi.fn(async (_title: string, options: string[]) => options[1]);
    await state.run("send 39a52f chosen", undefined, select);
    expect(select.mock.calls[0]?.[1]).toEqual([
      expect.stringContaining(`${peer.sessionId} · ${peer.endpointId}`), expect.stringContaining(`${other.sessionId} · ${other.endpointId}`),
    ]);
    expect(state.requests.at(-1)).toMatchObject({ type: "desktop_peer_send", target: other });
    const exact = setup(respond([{ ...peer, sessionId: "39a52f" }, peer]));
    await exact.run("send 39a52f exact");
    expect(exact.requests.at(-1)).toMatchObject({ type: "desktop_peer_send", target: { ...peer, sessionId: "39a52f" } });
  });

  it("distinguishes multiple endpoints of one session and never sends on cancellation or noninteractive ambiguity", async () => {
    const duplicate = { ...peer, endpointId: "endpoint-2", processGeneration: "generation-2" };
    const state = setup(respond([peer, duplicate]));
    const completions = await state.complete("send 39a52f");
    expect(completions).toMatchObject([
      { description: expect.stringContaining("endpoint · generation") }, { description: expect.stringContaining("endpoint-2 · generation-2") },
    ]);
    await state.run("send 39a52f ambiguous");
    await state.run("send 39a52f cancelled", undefined, async () => undefined);
    expect(state.requests.every((request) => request.type === "desktop_peer_list")).toBe(true);
    expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("ambiguous_peer"), "error");
    await state.run(`send ${peer.sessionId} selected`, undefined, async (_title, options) => options[1]);
    expect(state.requests.at(-1)).toMatchObject({ type: "desktop_peer_send", target: duplicate });
  });

  it("rejects unknown peers, incomplete commands and truncated lists without sending or querying candidates", async () => {
    const state = setup(respond([]));
    await state.run("send unknown hello");
    await state.run("send 39a52f");
    await state.run("send 39a52f   ");
    expect(state.notify.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining("peer_not_found"), expect.stringContaining("用法"), expect.stringContaining("用法"),
    ]);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list"]);
    const truncated = setup((request) => ({ ...respond([peer])(request), truncated: true }));
    expect(await truncated.complete("send ")).toBeNull();
    await truncated.run("send 39a52f hello");
    expect(truncated.notify).toHaveBeenCalledWith(expect.stringContaining("peer_list_truncated"), "error");
    expect(truncated.requests.every((request) => request.type === "desktop_peer_list")).toBe(true);
  });

  it("rejects legacy JSON input while allowing JSON as the message body", async () => {
    const state = setup(respond([peer]));
    await state.run(`send ${JSON.stringify({ target: peer, message: "hello" })}`);
    await state.run('send {"target":"39a52f","message":"hello"}');
    expect(state.requests).toHaveLength(0);
    expect(state.notify).toHaveBeenCalledTimes(2);
    expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("用法"), "error");
    await state.run('send 39a52f {"content":"hello world"}');
    expect(state.requests.at(-1)).toMatchObject({ type: "desktop_peer_send", target: peer, message: '{"content":"hello world"}' });
  });

  it("reports list failure and makes disconnected completion silent", async () => {
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "feature_not_negotiated" } }));
    expect(await state.complete("send ")).toBeNull();
    await state.run("send 39a52f hello");
    expect(state.notify).toHaveBeenCalledWith("feature_not_negotiated", "error");
    state.disconnect();
    const count = state.requests.length;
    expect(await state.complete("send ")).toBeNull();
    await state.run("send 39a52f hello");
    expect(state.requests).toHaveLength(count);
    expect(state.notify).toHaveBeenCalledWith("disconnected", "error");
  });

  it("discards a list response from a cleared session and never reuses completion targets for sending", async () => {
    let settle: (result: DesktopPeerResult) => void = () => undefined;
    const state = setup(() => new Promise<DesktopPeerResult>((resolve) => { settle = resolve; }));
    const pending = state.complete("send ");
    state.peerCommand.clear();
    settle({ type: "desktop_peer_result", requestId: "list", status: "listed", peers: [peer] });
    expect(await pending).toBeNull();
    let peers = [peer];
    const fresh = setup((request) => respond(peers)(request));
    await fresh.complete("send ");
    peers = [];
    await fresh.run(`send ${peer.sessionId} stale`);
    expect(fresh.requests.map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_list"]);
  });

  it("does not send after disconnect or session clear during target selection", async () => {
    for (const disconnect of [false, true]) {
      const state = setup(respond([peer, other]));
      await state.run("send 39a52f hello", undefined, async (_title, options) => {
        if (disconnect) state.disconnect(); else state.peerCommand.clear();
        return options[0];
      });
      expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list"]);
      expect(state.notify).toHaveBeenCalledWith("disconnected", "error");
    }
  });
});

describe("desktop peer TUI authorization", () => {
  it("never queries candidates without interactive approval", async () => {
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "candidates", candidates: [target], truncated: false }));
    await state.run("candidates");
    await state.run("candidates", async () => false);
    expect(state.requests).toHaveLength(0);
    await state.run("candidates", async () => true);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_candidates"]);
    expect(state.commandName).toBe("mb-peer");

    expect(JSON.stringify(state.messages)).toContain(target.processGeneration);
  });

  it("discovers unauthorized targets only after approval and retains the separate grant confirmation", async () => {
    const state = setup((request) => {
      if (request.type === "desktop_peer_list") return { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [] };
      if (request.type === "desktop_peer_candidates") return { type: "desktop_peer_result", requestId: request.requestId, status: "candidates", candidates: [target] };
      if (request.type === "desktop_peer_send") return { type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: target.normalizedCwd } };
      return { type: "desktop_peer_result", requestId: request.requestId, status: "access_granted" };
    });
    await state.run("send peer hello", async () => false);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list"]);
    const confirm = vi.fn(async (title: string) => title === "显示未授权 peer");
    await state.run("send peer hello", confirm);
    expect(confirm.mock.calls.map((call) => call[0])).toEqual(["显示未授权 peer", "跨工作目录授权"]);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_list", "desktop_peer_candidates", "desktop_peer_send"]);
    expect(state.requests.at(-1)).toMatchObject({ target, message: "hello" });
    await state.run("send peer hello", async () => true, async () => "允许双向");
    expect(state.requests.slice(-4).map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_candidates", "desktop_peer_send", "desktop_peer_access_grant"]);
    expect(state.requests.at(-1)).toMatchObject({ target, direction: "bidirectional" });
  });

  it("does not query candidates after the session changes during discovery approval", async () => {
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [] }));
    await state.run("send peer hello", async () => { state.peerCommand.clear(); return true; });
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list"]);
    expect(state.notify).toHaveBeenCalledWith("disconnected", "error");
  });

  it("does not grant after the session changes during authorization approval", async () => {
    const state = setup((request) => request.type === "desktop_peer_list"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [target] }
      : { type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: target.normalizedCwd } });
    await state.run("send peer hello", async () => { state.peerCommand.clear(); return true; });
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_send"]);
    expect(state.notify).toHaveBeenCalledWith("disconnected", "error");
  });

  it("does not grant or replay a denied or noninteractive send", async () => {
    const state = setup((request) => request.type === "desktop_peer_list"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [target] }
      : { type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: target.normalizedCwd } });
    const send = "send peer hello";
    await state.run(send);
    await state.run(send, async () => false);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_send", "desktop_peer_list", "desktop_peer_send"]);
    expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("消息未发送"), "info");
  });

  it("persists chosen direction then requires a new explicit send", async () => {
    const state = setup((request) => request.type === "desktop_peer_list"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [target] }
      : request.type === "desktop_peer_send"
        ? { type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: target.normalizedCwd } }
        : { type: "desktop_peer_result", requestId: request.requestId, status: "access_granted", grant: { grantId: "grant", sourceCwd: "/work/app", targetCwd: target.normalizedCwd, direction: "bidirectional", createdAt: Date.now(), managed: false } });
    await state.run("send peer hello", async () => true, async () => "允许双向");
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_list", "desktop_peer_send", "desktop_peer_access_grant"]);
    expect(state.requests[2]).toMatchObject({ direction: "bidirectional", target });
    expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("重新执行"), "info");
  });

  it("automatically accepts and retains deliveries in the inbox until clear", async () => {
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [] }));
    const delivery: DesktopPeerDelivery = {
      type: "desktop_peer_delivery",
      requestId: "request",
      deliveryId: "delivery",
      source: { sessionId: "source", endpointId: "endpoint", normalizedCwd: "/source", processGeneration: "generation" },
      target,
      deadlineAt: Date.now() + 5_000,
      message: "hello",
    };
    await expect(state.peerCommand.receive(delivery)).resolves.toBeUndefined();
    await expect(state.peerCommand.receive(delivery)).rejects.toThrow("inbox_unavailable");
    await state.run("inbox");
    expect(state.messages[1]).toMatchObject({ content: expect.stringContaining('"deliveryId": "delivery"') });
    state.peerCommand.clear();
    await state.run("inbox");
    expect(state.messages.at(-1)).toMatchObject({ content: "[]" });
  });

  it("rejects expired deliveries and removes queued deliveries at their deadline", async () => {
    vi.useFakeTimers();
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [] }));
    const delivery: DesktopPeerDelivery = {
      type: "desktop_peer_delivery", requestId: "expiry", deliveryId: "expiry",
      source: target, target, deadlineAt: Date.now() + 1_000, message: "hello",
    };
    try {
      await expect(state.peerCommand.receive({ ...delivery, deadlineAt: Date.now() })).rejects.toThrow("inbox_unavailable");
      expect(state.messages).toHaveLength(0);
      await expect(state.peerCommand.receive(delivery)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(999);
      await state.run("inbox");
      expect(state.messages.at(-1)).toMatchObject({ content: JSON.stringify([delivery], null, 2) });
      await vi.advanceTimersByTimeAsync(1);
      await state.run("inbox");
      expect(state.messages.at(-1)).toMatchObject({ content: "[]" });
      await expect(state.peerCommand.receive(delivery)).rejects.toThrow("inbox_unavailable");
    } finally {
      state.peerCommand.clear();
      vi.useRealTimers();
    }
  });

  it("rejects deliveries when full and releases capacity and timers on clear", async () => {
    vi.useFakeTimers();
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [] }));
    const delivery: DesktopPeerDelivery = {
      type: "desktop_peer_delivery", requestId: "capacity", deliveryId: "capacity",
      source: target, target, deadlineAt: Date.now() + 1_000, message: "hello",
    };
    try {
      for (let index = 0; index < DESKTOP_PEER_MAX_PEERS; index += 1) {
        await expect(state.peerCommand.receive({ ...delivery, deliveryId: `delivery-${index}` })).resolves.toBeUndefined();
      }
      await expect(state.peerCommand.receive(delivery)).rejects.toThrow("inbox_unavailable");
      await state.run("inbox");
      expect(state.messages.at(-1)).toMatchObject({ content: expect.not.stringContaining('"deliveryId": "capacity"') });
      state.peerCommand.clear();
      expect(vi.getTimerCount()).toBe(0);
      await expect(state.peerCommand.receive(delivery)).resolves.toBeUndefined();
      await state.run("inbox");
      expect(state.messages.at(-1)).toMatchObject({ content: JSON.stringify([delivery], null, 2) });
    } finally {
      state.peerCommand.clear();
      vi.useRealTimers();
    }
  });

  it("lists and revokes grants through Broker and leaves allowed sends alone", async () => {
    const state = setup((request) => request.type === "desktop_peer_list"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "listed", peers: [target] }
      : request.type === "desktop_peer_send"
        ? { type: "desktop_peer_result", requestId: request.requestId, status: "accepted", deliveryId: "delivery" }
        : { type: "desktop_peer_result", requestId: request.requestId, status: request.type === "desktop_peer_access_list" ? "access_listed" : "access_revoked", grants: [], grantId: "grant" });
    await state.run("access");
    await state.run("revoke grant");
    await state.run("send peer hello");
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_access_list", "desktop_peer_access_revoke", "desktop_peer_list", "desktop_peer_send"]);
    expect(state.notify).not.toHaveBeenCalled();
  });
});

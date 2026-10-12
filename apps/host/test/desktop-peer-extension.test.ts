import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DESKTOP_PEER_MAX_PEERS } from "@maestro-mobile/shared";
import type { DesktopPeerDelivery, DesktopPeerRequest, DesktopPeerResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { registerDesktopPeerCommand } from "../src/plugin/desktop-peer-extension.js";
import type { DesktopPluginIpcClient } from "../src/plugin/desktop-plugin-ipc.js";

const target: DesktopPluginTarget = { sessionId: "peer", endpointId: "endpoint", normalizedCwd: "/another", processGeneration: "generation" };

function setup(result: (request: DesktopPeerRequest) => DesktopPeerResult) {
  let handler: (args: string, ctx: unknown) => Promise<void> = async () => undefined;
  const messages: unknown[] = [];
  const requests: DesktopPeerRequest[] = [];
  let commandName = "";
  const pi = {
    registerCommand: (name: string, _command: { handler: typeof handler }) => { commandName = name; handler = _command.handler; },
    sendMessage: (message: unknown) => messages.push(message),
  };
  const client = { requestPeers: async (request: DesktopPeerRequest) => { requests.push(request); return result(request); } };
  const peerCommand = registerDesktopPeerCommand(pi as unknown as ExtensionAPI, () => client as unknown as DesktopPluginIpcClient);
  const notify = vi.fn();
  const run = async (command: string, confirm?: (title: string, message: string) => Promise<boolean>, select?: (title: string, options: string[]) => Promise<string | undefined>) =>
    handler(command, { ui: { notify, confirm, select } });
  return { run, requests, messages, notify, peerCommand, get commandName() { return commandName; } };
}

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

  it("does not grant or replay a denied or noninteractive send", async () => {
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: target.normalizedCwd } }));
    const send = `send ${JSON.stringify({ target, message: "hello" })}`;
    await state.run(send);
    await state.run(send, async () => false);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_send", "desktop_peer_send"]);
    expect(state.notify).toHaveBeenCalledWith(expect.stringContaining("消息未发送"), "info");
  });

  it("persists chosen direction then requires a new explicit send", async () => {
    const state = setup((request) => request.type === "desktop_peer_send"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "failed", error: { code: "authorization_required" }, authorization: { sourceCwd: "/work/app", targetCwd: target.normalizedCwd } }
      : { type: "desktop_peer_result", requestId: request.requestId, status: "access_granted", grant: { grantId: "grant", sourceCwd: "/work/app", targetCwd: target.normalizedCwd, direction: "bidirectional", createdAt: Date.now(), managed: false } });
    await state.run(`send ${JSON.stringify({ target, message: "hello" })}`, async () => true, async () => "允许双向");
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_send", "desktop_peer_access_grant"]);
    expect(state.requests[1]).toMatchObject({ direction: "bidirectional", target });
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
    const state = setup((request) => request.type === "desktop_peer_send"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "accepted", deliveryId: "delivery" }
      : { type: "desktop_peer_result", requestId: request.requestId, status: request.type === "desktop_peer_access_list" ? "access_listed" : "access_revoked", grants: [], grantId: "grant" });
    await state.run("access");
    await state.run("revoke grant");
    await state.run(`send ${JSON.stringify({ target, message: "hello" })}`);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_access_list", "desktop_peer_access_revoke", "desktop_peer_send"]);
    expect(state.notify).not.toHaveBeenCalled();
  });
});

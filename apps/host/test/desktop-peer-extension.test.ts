import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopPeerRequest, DesktopPeerResult, DesktopPluginTarget } from "@maestro-mobile/shared";
import { registerDesktopPeerCommand } from "../src/plugin/desktop-peer-extension.js";
import type { DesktopPluginIpcClient } from "../src/plugin/desktop-plugin-ipc.js";

const target: DesktopPluginTarget = { sessionId: "peer", endpointId: "endpoint", normalizedCwd: "/another", processGeneration: "generation" };

function setup(result: (request: DesktopPeerRequest) => DesktopPeerResult) {
  let handler: (args: string, ctx: unknown) => Promise<void> = async () => undefined;
  const messages: unknown[] = [];
  const requests: DesktopPeerRequest[] = [];
  const pi = {
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    sendMessage: (message: unknown) => messages.push(message),
  };
  const client = { requestPeers: async (request: DesktopPeerRequest) => { requests.push(request); return result(request); } };
  registerDesktopPeerCommand(pi as unknown as ExtensionAPI, () => client as unknown as DesktopPluginIpcClient);
  const notify = vi.fn();
  const run = async (command: string, confirm?: (title: string, message: string) => Promise<boolean>, select?: (title: string, options: string[]) => Promise<string | undefined>) =>
    handler(command, { ui: { notify, confirm, select } });
  return { run, requests, messages, notify };
}

describe("desktop peer TUI authorization", () => {
  it("never queries candidates without interactive approval", async () => {
    const state = setup((request) => ({ type: "desktop_peer_result", requestId: request.requestId, status: "candidates", candidates: [target], truncated: false }));
    await state.run("candidates");
    await state.run("candidates", async () => false);
    expect(state.requests).toHaveLength(0);
    await state.run("candidates", async () => true);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_candidates"]);
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

  it("lists and revokes grants through Broker and leaves allowed sends alone", async () => {
    const state = setup((request) => request.type === "desktop_peer_send"
      ? { type: "desktop_peer_result", requestId: request.requestId, status: "acknowledged", deliveryId: "delivery" }
      : { type: "desktop_peer_result", requestId: request.requestId, status: request.type === "desktop_peer_access_list" ? "access_listed" : "access_revoked", grants: [], grantId: "grant" });
    await state.run("access");
    await state.run("revoke grant");
    await state.run(`send ${JSON.stringify({ target, message: "hello" })}`);
    expect(state.requests.map((request) => request.type)).toEqual(["desktop_peer_access_list", "desktop_peer_access_revoke", "desktop_peer_send"]);
    expect(state.notify).not.toHaveBeenCalled();
  });
});

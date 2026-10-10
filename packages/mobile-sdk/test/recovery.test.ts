import { describe, expect, it } from "vitest";
import { createMobileClient, type WebSocketLike } from "../src/client.js";
import {
  createMobileRecovery,
  RecoveryBufferOverflowError,
  RecoveryCancelledError,
} from "../src/recovery.js";
import type { HostEvent, SessionSnapshot, SessionTargetIdentity } from "../src/protocol/index.js";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const target: SessionTargetIdentity = {
  sessionId: "s1", endpointId: "desktop-1", normalizedCwd: "/work", processGeneration: "p1",
};
const sibling: SessionTargetIdentity = { ...target, endpointId: "desktop-2" };

function snapshot(nextSeq: number, wireSeq?: number): SessionSnapshot {
  return {
    session: {
      id: "s1", cwd: "/work", title: "Test", runState: "idle", messageCount: 1,
      pendingMessageCount: 0, updatedAt: "2026-01-01T00:00:00Z",
    },
    timeline: [], nextSeq, ...(wireSeq === undefined ? {} : { wireSeq }),
  };
}

function timelineEvent(seq: number, eventTarget = target): HostEvent {
  return {
    type: "timeline_item", sessionId: "s1", target: eventTarget, seq,
    item: { id: `m-${seq}`, kind: "assistant", text: `消息 ${seq}`, createdAt: "2026-01-01T00:00:00Z" },
  };
}

function connectedClient(socket: FakeSocket): ReturnType<typeof createMobileClient> {
  const client = createMobileClient({ url: "ws://host/ws", wsFactory: () => socket });
  client.connect();
  socket.open();
  socket.receive({ type: "protocol_ready", protocolVersion: 2, hostVersion: "1", capabilities: [], revision: 1 });
  return client;
}

function respondSnapshotAt(socket: FakeSocket, index: number, value: SessionSnapshot): void {
  const command = JSON.parse(socket.sent[index]) as { id: string };
  socket.receive({ type: "command_result", in_reply_to: command.id, ok: true, status: "observed", revision: 2, result: value });
}

function respondSnapshot(socket: FakeSocket, value: SessionSnapshot): void {
  respondSnapshotAt(socket, socket.sent.length - 1, value);
}

describe("Mobile recovery coordinator", () => {
  it("emits snapshot then only events at or after the exclusive wire cut", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const updates: string[] = [];
    const recovery = createMobileRecovery(client, { onUpdate: (u) => updates.push(u.type) });
    const promise = recovery.recoverSession(target);
    socket.receive(timelineEvent(9));
    socket.receive(timelineEvent(10));
    respondSnapshot(socket, snapshot(100, 10));
    const result = await promise;
    expect(result.status).toBe("applied");
    expect(result.status === "applied" ? result.replayedEvents.map((e) => e.seq) : []).toEqual([10]);
    expect(updates).toEqual(["snapshot"]);
    client.dispose();
  });

  it("does not compare runner nextSeq with Host wireSeq and isolates sibling targets", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const events: HostEvent[] = [];
    const recovery = createMobileRecovery(client, { onUpdate: (u) => { if (u.type === "event") events.push(u.event); } });
    const first = recovery.recoverSession(target);
    const firstCommandIndex = socket.sent.length - 1;
    const second = recovery.recoverSession(sibling);
    const secondCommandIndex = socket.sent.length - 1;
    socket.receive(timelineEvent(3, target));
    socket.receive(timelineEvent(4, sibling));
    // Responses are deliberately completed in reverse order.
    respondSnapshotAt(socket, secondCommandIndex, snapshot(1, 4));
    const secondResult = await second;
    respondSnapshotAt(socket, firstCommandIndex, snapshot(100, 4));
    const firstResult = await first;
    expect(secondResult.status).toBe("applied");
    expect(firstResult.status).toBe("applied");
    expect(firstResult.status === "applied" ? firstResult.replayedEvents.map((e) => e.seq) : []).toEqual([]);
    expect(secondResult.status === "applied" ? secondResult.replayedEvents.map((e) => e.seq) : []).toEqual([4]);
    expect(events).toEqual([]);
    client.dispose();
  });

  it("delivers independent events immediately while overlap events buffer", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const events: HostEvent[] = [];
    const recovery = createMobileRecovery(client, { onUpdate: (u) => { if (u.type === "event") events.push(u.event); } });
    const promise = recovery.recoverSession(target);
    const notification: HostEvent = {
      type: "notification_event", eventId: "n1", kind: "session_error", sessionId: "s1", title: "错误", body: "失败",
      occurredAt: "2026-01-01T00:00:00Z", dedupeKey: "n1", seq: 99,
    };
    socket.receive(notification);
    socket.receive(timelineEvent(5));
    expect(events).toEqual([notification]);
    respondSnapshot(socket, snapshot(1, 5));
    const result = await promise;
    expect(result.status === "applied" ? result.replayedEvents.map((e) => e.seq) : []).toEqual([5]);
    client.dispose();
  });

  it("supports local cancellation without closing the shared client and releases buffered events", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const events: HostEvent[] = [];
    const recovery = createMobileRecovery(client, { onUpdate: (u) => { if (u.type === "event") events.push(u.event); } });
    const controller = new AbortController();
    const promise = recovery.recoverSession(target, { signal: controller.signal });
    socket.receive(timelineEvent(1));
    controller.abort();
    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(client.isProtocolReady).toBe(true);
    client.dispose();
  });

  it("rejects a recovery when its bounded byte budget is exceeded", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const recovery = createMobileRecovery(client, { maxBufferedBytes: 8 });
    const promise = recovery.recoverSession(target);
    socket.receive(timelineEvent(1));
    await expect(promise).rejects.toBeInstanceOf(RecoveryBufferOverflowError);
    expect(recovery.getWatermarks(target)).toMatchObject({ wireSeq: 1 });
    client.dispose();
  });

  it("resets generation and drops old recovery state on disconnect", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const recovery = createMobileRecovery(client);
    const before = recovery.generation;
    const promise = recovery.recoverSession(target);
    socket.close();
    const result = await promise;
    expect(result.status).toBe("connection_lost");
    expect(recovery.generation).toBeGreaterThan(before);
    expect(recovery.getWatermarks(target)).toEqual({});
    client.dispose();
  });

  it("rejects legacy unordered snapshots after a live projection exists", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const recovery = createMobileRecovery(client);
    const first = recovery.recoverSession(target);
    socket.receive(timelineEvent(4));
    respondSnapshot(socket, snapshot(1, 4));
    await first;
    const second = recovery.recoverSession(target);
    respondSnapshot(socket, snapshot(0));
    await expect(second).resolves.toMatchObject({ status: "superseded" });
    client.dispose();
  });

  it("rejects an unordered legacy snapshot while a live overlap event is buffered", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const recovery = createMobileRecovery(client);
    const promise = recovery.recoverSession(target);
    socket.receive(timelineEvent(7));
    respondSnapshot(socket, snapshot(0));
    await expect(promise).resolves.toMatchObject({ status: "superseded" });
    expect(recovery.getWatermarks(target)).toMatchObject({ wireSeq: 7 });
    client.dispose();
  });
  it("refreshes typed bootstrap projections and does not emit synthetic seq events", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const updates: string[] = [];
    const recovery = createMobileRecovery(client, { onUpdate: (update) => updates.push(update.type) });
    const handled = new Set<string>();
    const respondBootstrapFrames = () => {
      for (const raw of socket.sent) {
        const frame = JSON.parse(raw) as { id: string; type: string };
        if (handled.has(frame.id)) continue;
        if (frame.type === "get_execution_projections") {
          handled.add(frame.id);
          socket.receive({ type: "command_result", in_reply_to: frame.id, ok: true, status: "observed", revision: 3, result: { projections: [], revision: 3 } });
        } else if (frame.type === "get_maestro_state") {
          handled.add(frame.id);
          socket.receive({ type: "command_result", in_reply_to: frame.id, ok: true, status: "observed", revision: 3, result: { schedules: [], observedAt: "now" } });
        } else if (frame.type === "list_host_sessions") {
          handled.add(frame.id);
          socket.receive({ type: "command_result", in_reply_to: frame.id, ok: true, status: "observed", revision: 3, result: { sessions: [], observedAt: "now" } });
        }
      }
    };
    await Promise.resolve();
    respondBootstrapFrames();
    await recovery.refresh();
    respondBootstrapFrames();
    await Promise.resolve();
    expect(updates.filter((type) => type === "bootstrap")).toHaveLength(3);
    expect(updates).not.toContain("event");
    recovery.dispose(); client.dispose();
  });

  it("exposes the cancellation error for a pre-aborted signal", async () => {
    const socket = new FakeSocket();
    const client = connectedClient(socket);
    const controller = new AbortController();
    controller.abort();
    const recovery = createMobileRecovery(client);
    const promise = recovery.recoverSession(target, { signal: controller.signal });
    await expect(promise).resolves.toMatchObject({ status: "cancelled" });
    expect(new RecoveryCancelledError().code).toBe("recovery_cancelled");
    recovery.dispose();
    client.dispose();
  });
});

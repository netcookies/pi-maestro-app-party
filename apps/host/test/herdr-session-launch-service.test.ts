import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrSessionLaunchService, type HerdrLaunchRegistry } from "../src/herdr-session-launch-service.js";
import { HerdrLaunchStore, type HerdrLaunchStoreData } from "../src/herdr-launch-store.js";
import type { DesktopPluginTarget } from "@maestro-mobile/shared";
import { HerdrAdapterError, type HerdrAdapter } from "../src/herdr-adapter.js";

const targetA: DesktopPluginTarget = { sessionId: "s-a", endpointId: "e-a", normalizedCwd: "/work", processGeneration: "p-a" };
const targetB: DesktopPluginTarget = { sessionId: "s-b", endpointId: "e-b", normalizedCwd: "/work", processGeneration: "p-b" };

function registry(): HerdrLaunchRegistry & { records: Array<{ target: DesktopPluginTarget; launchNonce?: string }> } {
  return { epoch: "broker-1", isValid: true, records: [], list() { return this.records; } };
}

function adapter(launchPiPane: HerdrAdapter["launchPiPane"]): HerdrAdapter {
  return { launchPiPane } as HerdrAdapter;
}

describe("HerdrSessionLaunchService", () => {
  it("binds the exact Pi target through nonce and keeps same-cwd launches distinct", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "herdr-launch-"));
    try {
      const normalizedCwd = await realpath(cwd);
      const projection = registry();
      const firstTarget = { ...targetA, normalizedCwd };
      const secondTarget = { ...targetB, normalizedCwd };
      const launcher = adapter(async ({ requestId }) => {
        const isFirst = requestId === "r1";
        const launchNonce = isFirst ? "a".repeat(32) : "b".repeat(32);
        projection.records.push({ target: isFirst ? firstTarget : secondTarget, launchNonce });
        return { paneId: isFirst ? "w:p1" : "w:p2", launchNonce };
      });
      const service = new HerdrSessionLaunchService(projection, launcher);
      const [first, second] = await Promise.all([service.launch("r1", cwd), service.launch("r2", cwd)]);
      expect(first).toMatchObject({ status: "ready", target: firstTarget });
      expect(second).toMatchObject({ status: "ready", target: secondTarget });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not repeat external effects for a duplicate request id", async () => {
    const projection = registry();
    const start = vi.fn(async () => ({ paneId: "w:p1", launchNonce: "a".repeat(32) }));
    let now = 0;
    const service = new HerdrSessionLaunchService(projection, adapter(start), undefined, () => now, async () => { now += 31_000; });
    const cwd = await mkdtemp(join(tmpdir(), "herdr-launch-timeout-"));
    const first = service.launch("same", cwd);
    const duplicate = service.launch("same", "/different");
    expect(await first).toMatchObject({ status: "unknown", stage: "registration_timeout" });
    expect(await duplicate).toEqual(await first);
    expect(start).toHaveBeenCalledTimes(1);
    await rm(cwd, { recursive: true, force: true });
  });

  it("reports external launch-stage failures as unknown and does not replay them", async () => {
    const projection = registry();
    const launchPiPane = vi.fn(async () => {
      throw new HerdrAdapterError("herdr_operation_failed", "create_pane", "Herdr command timed out");
    });
    const service = new HerdrSessionLaunchService(projection, adapter(launchPiPane));
    const first = await service.launch("uncertain", "/work");
    const replay = await service.launch("uncertain", "/another");
    expect(first).toMatchObject({ status: "unknown", stage: "create_pane_outcome_unknown", error: { code: "herdr_operation_outcome_unknown" } });
    expect(replay).toEqual(first);
    expect(launchPiPane).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the Broker epoch changes before nonce registration", async () => {
    const projection = registry();
    const start = vi.fn(async () => {
      projection.isValid = false;
      return { paneId: "w:p1", launchNonce: "a".repeat(32) };
    });
    const service = new HerdrSessionLaunchService(projection, adapter(start), undefined, Date.now, async () => { throw new Error("should not poll after epoch change"); });
    await expect(service.launch("epoch", "/work")).resolves.toMatchObject({ status: "unknown", stage: "broker_epoch_changed" });
  });
});

function closeHarness(options: { registered?: boolean; running?: boolean; livePanes?: Array<{ paneId: string; workspaceId?: string; agent?: string; agentStatus?: string }> } = {}) {
  const projection = registry();
  const target = { ...targetA };
  if (options.registered !== false) {
    projection.records.push({ target, ...(options.running ? { runtimeStatus: "running" } : {}) });
  }
  const ctrlD = vi.fn(async () => undefined);
  const closeWorkspace = vi.fn(async () => undefined);
  const listPanes = vi.fn(async () => options.livePanes ?? []);
  const adapterStub = { sendCtrlD: ctrlD, closeWorkspace, listPanes } as unknown as HerdrAdapter;
  return { projection, target, ctrlD, closeWorkspace, listPanes, adapterStub };
}

async function tempStore(): Promise<{ store: HerdrLaunchStore; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-close-"));
  const file = join(dir, "cfg.json");
  return { store: new HerdrLaunchStore(file), file };
}

function launchRecord(target: DesktopPluginTarget, paneId = "w9:p1"): HerdrLaunchStoreData["launchedSpaces"][number] {
  return { paneId, target: { ...target }, cwd: target.normalizedCwd, launchedAt: new Date(0).toISOString(), workspaceId: "w9" };
}

describe("HerdrSessionLaunchService.close", () => {
  it("rejects closing a session this Host did not launch", async () => {
    const { projection, target, adapterStub } = closeHarness();
    const { store, file } = await tempStore();
    try {
      const service = new HerdrSessionLaunchService(projection, adapterStub, store);
      await expect(service.close("c1", target)).resolves.toEqual({ requestId: "c1", status: "herdr_session_not_owned" });
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("refuses to blind-send ctrl+d while the session is running", async () => {
    const { projection, target, adapterStub, ctrlD } = closeHarness({ running: true });
    const { store, file } = await tempStore();
    try {
      await store.recordLaunch(launchRecord(target));
      const service = new HerdrSessionLaunchService(projection, adapterStub, store);
      await expect(service.close("c1", target)).resolves.toMatchObject({ status: "herdr_session_busy", paneId: "w9:p1" });
      expect(ctrlD).not.toHaveBeenCalled();
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("closes once the Broker registration disappears and cleans the empty space", async () => {
    const { projection, target, adapterStub, ctrlD, closeWorkspace } = closeHarness();
    const { store, file } = await tempStore();
    try {
      await store.recordLaunch(launchRecord(target));
      let elapsed = 0;
      const service = new HerdrSessionLaunchService(
        projection,
        adapterStub,
        store,
        () => elapsed,
        async () => { elapsed += 200; projection.records.length = 0; },
      );
      await expect(service.close("c1", target)).resolves.toEqual({ requestId: "c1", status: "closed", paneId: "w9:p1", workspaceId: "w9" });
      expect(ctrlD).toHaveBeenCalledWith("w9:p1");
      expect(closeWorkspace).toHaveBeenCalledWith("w9");
      expect(await store.listLaunches()).toEqual([]);
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("keeps the registration on close_timeout so the client can retry", async () => {
    const { projection, target, adapterStub, closeWorkspace } = closeHarness();
    const { store, file } = await tempStore();
    try {
      await store.recordLaunch(launchRecord(target));
      let elapsed = 0;
      const service = new HerdrSessionLaunchService(
        projection,
        adapterStub,
        store,
        () => elapsed,
        async () => { elapsed += 11_000; },
      );
      await expect(service.close("c1", target)).resolves.toMatchObject({ status: "close_timeout", paneId: "w9:p1" });
      expect(closeWorkspace).not.toHaveBeenCalled();
      expect((await store.listLaunches()).length).toBe(1);
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("does not close the space while another pane still lives there", async () => {
    const { projection, target, adapterStub, closeWorkspace } = closeHarness({
      livePanes: [{ paneId: "w9:p1", workspaceId: "w9", agentStatus: "unknown" }, { paneId: "w9:p2", workspaceId: "w9", agent: "pi", agentStatus: "idle" }],
    });
    const { store, file } = await tempStore();
    try {
      await store.recordLaunch(launchRecord(target));
      let elapsed = 0;
      const service = new HerdrSessionLaunchService(
        projection,
        adapterStub,
        store,
        () => elapsed,
        async () => { elapsed += 200; projection.records.length = 0; },
      );
      await expect(service.close("c1", target)).resolves.toMatchObject({ status: "closed" });
      expect(closeWorkspace).not.toHaveBeenCalled();
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("closes the space when only a leftover shell pane remains", async () => {
    // Pi 退出后 Herdr 仍保留 shell pane；此时 workspace 内没有存活 agent，应清理。
    const { projection, target, adapterStub, closeWorkspace } = closeHarness({
      livePanes: [{ paneId: "w9:p1", workspaceId: "w9", agentStatus: "unknown" }],
    });
    const { store, file } = await tempStore();
    try {
      await store.recordLaunch(launchRecord(target));
      let elapsed = 0;
      const service = new HerdrSessionLaunchService(
        projection,
        adapterStub,
        store,
        () => elapsed,
        async () => { elapsed += 200; projection.records.length = 0; },
      );
      await expect(service.close("c1", target)).resolves.toMatchObject({ status: "closed" });
      expect(closeWorkspace).toHaveBeenCalledWith("w9");
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("drops registrations whose pane has no live agent during reconciliation", async () => {
    const { projection, target, adapterStub } = closeHarness({
      livePanes: [
        { paneId: "w9:p1", workspaceId: "w9", agentStatus: "unknown" },
        { paneId: "w8:p1", workspaceId: "w8", agent: "pi", agentStatus: "idle" },
      ],
    });
    const { store, file } = await tempStore();
    try {
      await store.recordLaunch(launchRecord(target, "w9:p1"));
      await store.recordLaunch(launchRecord({ ...target, sessionId: "s-2" }, "w8:p1"));
      const service = new HerdrSessionLaunchService(projection, adapterStub, store);
      await expect(service.reconcileLaunchedSpaces()).resolves.toBe(1);
      expect((await store.listLaunches()).map((entry) => entry.paneId)).toEqual(["w8:p1"]);
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });
});

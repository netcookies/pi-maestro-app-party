import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrSessionLaunchService, type HerdrLaunchRegistry } from "../src/herdr-session-launch-service.js";
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
    const service = new HerdrSessionLaunchService(projection, adapter(start), () => now, async () => { now += 31_000; });
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
    const service = new HerdrSessionLaunchService(projection, adapter(start), Date.now, async () => { throw new Error("should not poll after epoch change"); });
    await expect(service.launch("epoch", "/work")).resolves.toMatchObject({ status: "unknown", stage: "broker_epoch_changed" });
  });
});

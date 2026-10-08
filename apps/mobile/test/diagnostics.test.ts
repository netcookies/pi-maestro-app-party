import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));

import { DiagnosticRingBuffer, MAX_MESSAGE_LENGTH } from "../src/diagnostics";

function entry(id: string, message = id) {
  return { id, timestamp: `2026-01-01T00:00:0${id}Z`, kind: "local" as const, source: "test", message };
}

describe("DiagnosticRingBuffer", () => {
  it("keeps newest entries first and evicts the oldest at the bound", () => {
    const ring = new DiagnosticRingBuffer(2);
    ring.add(entry("1"));
    ring.add(entry("2"));
    ring.add(entry("3"));

    expect(ring.snapshot().map((item) => item.id)).toEqual(["3", "2"]);
    expect(ring.size).toBe(2);
  });

  it("moves duplicate ids to the front without growing", () => {
    const ring = new DiagnosticRingBuffer(3);
    ring.add(entry("1", "first"));
    ring.add(entry("2"));
    ring.add(entry("1", "updated"));

    expect(ring.snapshot().map((item) => item.id)).toEqual(["1", "2"]);
    expect(ring.snapshot()[0]?.message).toBe("updated");
  });

  it("bounds message size and returns defensive snapshots", () => {
    const ring = new DiagnosticRingBuffer(1);
    ring.add(entry("1", `  ${"x".repeat(MAX_MESSAGE_LENGTH + 20)}  `));
    const snapshot = ring.snapshot();
    snapshot[0]!.message = "mutated";

    expect(ring.snapshot()[0]?.message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("loads persisted entries with the same newest-first bound", () => {
    const ring = new DiagnosticRingBuffer(2);
    ring.replace([entry("3"), entry("2"), entry("1")]);

    expect(ring.snapshot().map((item) => item.id)).toEqual(["3", "2"]);
  });

});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("diagnostics persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    storage.getItem.mockReset();
    storage.setItem.mockReset().mockResolvedValue(undefined);
  });

  it("waits for hydration before writing and preserves previous history", async () => {
    const read = deferred<string | null>();
    storage.getItem.mockReturnValue(read.promise);
    const diagnostics = await import("../src/diagnostics");
    const fresh = diagnostics.recordDiagnostic({ kind: "local", source: "test", message: "new" });
    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalled();

    read.resolve(JSON.stringify([entry("1", "previous history")]));
    await diagnostics.loadDiagnostics();
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    expect(diagnostics.getDiagnostics().map((item) => item.id)).toEqual([fresh.id, "1"]);
    expect(JSON.parse(storage.setItem.mock.calls[0]![1]).map((item: { id: string }) => item.id))
      .toEqual([fresh.id, "1"]);
  });

  it("does not resurrect history when clearing during hydration", async () => {
    const read = deferred<string | null>();
    storage.getItem.mockReturnValue(read.promise);
    const diagnostics = await import("../src/diagnostics");
    diagnostics.recordDiagnostic({ kind: "local", source: "test", message: "before clear" });
    diagnostics.clearDiagnostics();
    const fresh = diagnostics.recordDiagnostic({ kind: "local", source: "test", message: "after clear" });

    read.resolve(JSON.stringify([entry("1", "previous history")]));
    await diagnostics.loadDiagnostics();
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    expect(diagnostics.getDiagnostics().map((item) => item.id)).toEqual([fresh.id]);
    expect(JSON.parse(storage.setItem.mock.calls[0]![1]).map((item: { id: string }) => item.id))
      .toEqual([fresh.id]);
  });

  it("persists an empty buffer after clearing while a prior write is pending", async () => {
    storage.getItem.mockResolvedValue(null);
    const write = deferred<void>();
    storage.setItem.mockReturnValueOnce(write.promise);
    const diagnostics = await import("../src/diagnostics");
    await diagnostics.loadDiagnostics();
    diagnostics.recordDiagnostic({ kind: "local", source: "test", message: "before clear" });
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    diagnostics.clearDiagnostics();
    write.resolve(undefined);
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(2));
    expect(JSON.parse(storage.setItem.mock.calls[1]![1])).toEqual([]);
    expect(diagnostics.getDiagnostics()).toEqual([]);
  });
});


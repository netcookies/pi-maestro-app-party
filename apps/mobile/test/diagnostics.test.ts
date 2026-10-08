import { describe, expect, it } from "vitest";
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

  it("keeps persisted history when a new entry is recorded during hydration", () => {
    const ring = new DiagnosticRingBuffer(3);
    const persisted = entry("old");
    ring.replace([persisted]);
    ring.add(entry("new"));

    expect(ring.snapshot().map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("does not restore entries after an explicit clear", () => {
    const ring = new DiagnosticRingBuffer(2);
    ring.add(entry("old"));
    ring.clear();

    expect(ring.snapshot()).toEqual([]);
  });
});


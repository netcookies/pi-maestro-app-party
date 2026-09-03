import { describe, expect, it } from "vitest";
import { validateHostEvent, validateClientCommand, validateJsonSerializable } from "../src/validation.js";

describe("validation", () => {
  it("accepts well-formed events and commands", () => {
    expect(() => validateHostEvent({ type: "host_status", status: "idle", seq: 1 })).not.toThrow();
    expect(() => validateClientCommand({ type: "abort", sessionId: "s1" })).not.toThrow();
  });

  it("rejects malformed inputs", () => {
    expect(() => validateHostEvent({ type: "host_status", status: "idle" })).toThrow();
    expect(() => validateClientCommand(null)).toThrow();
  });

  it("checks JSON serializability", () => {
    expect(() => validateJsonSerializable({ a: 1, b: [2, 3] })).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateJsonSerializable(circular)).toThrow();
  });
});

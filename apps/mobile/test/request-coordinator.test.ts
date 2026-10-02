import { describe, expect, it } from "vitest";
import { singleFlight, stableRequestKey } from "../src/request-coordinator.js";

describe("request coordinator", () => {
  it("reuses an in-flight request for equivalent object keys", async () => {
    const flights = new Map<string, Promise<unknown>>();
    let calls = 0;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    const first = singleFlight(flights, stableRequestKey("sessions", { b: 2, a: 1 }), async () => { calls += 1; return pending; });
    const second = singleFlight(flights, stableRequestKey("sessions", { a: 1, b: 2 }), async () => { calls += 1; return "wrong"; });
    resolve("ok");
    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(calls).toBe(1);
  });

  it("does not merge different keys and releases after failure", async () => {
    const flights = new Map<string, Promise<unknown>>();
    let calls = 0;
    const fail = () => singleFlight(flights, "same", async () => { calls += 1; throw new Error("failed"); });
    await expect(fail()).rejects.toThrow("failed");
    await expect(fail()).rejects.toThrow("failed");
    const other = singleFlight(flights, "other", async () => { calls += 1; return 2; });
    await expect(other).resolves.toBe(2);
    expect(calls).toBe(3);
  });
});

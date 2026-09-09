import { describe, expect, it } from "vitest";
import { isPairingFlowActive, resolvePairingCandidate, shouldBlockPairingBack } from "../src/pair-scan-logic.js";
import { extractPairing } from "../src/pairing.js";

describe("pair scan candidate decision", () => {
  it("rejects continuation after unmount, cancellation, or abort", () => {
    expect(isPairingFlowActive(true, false, false)).toBe(true);
    expect(isPairingFlowActive(false, false, false)).toBe(false);
    expect(isPairingFlowActive(true, true, false)).toBe(false);
    expect(isPairingFlowActive(true, false, true)).toBe(false);
  });
  it("blocks back only while a saving commit is in progress", () => {
    expect(shouldBlockPairingBack("saving")).toBe(true);
    expect(shouldBlockPairingBack("saving", true)).toBe(false);
    expect(shouldBlockPairingBack("error")).toBe(false);
    expect(shouldBlockPairingBack("selecting")).toBe(false);
  });

  it("resolves a single candidate without an explicit selection", () => {
    const info = extractPairing("ws://192.168.1.5:4739/ws?token=t")!;
    expect(resolvePairingCandidate(info)).toMatchObject({
      hostUrl: "ws://192.168.1.5:4739/ws",
      displayHost: "192.168.1.5:4739",
    });
  });

  it("requires a selection before resolving multiple candidates", () => {
    const info = extractPairing("maestro-mobile://pair?ws=ws%3A%2F%2F192.168.1.5%3A4739%2Fws&token=t&ips=192.168.1.5,10.0.0.2")!;
    expect(resolvePairingCandidate(info)).toBeNull();
    expect(resolvePairingCandidate(info, "10.0.0.2")).toMatchObject({
      hostUrl: "ws://10.0.0.2:4739/ws",
      displayHost: "10.0.0.2:4739",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  isCompatibleProtocolVersion,
  isCompatibleReleaseVersion,
  isProtocolHello,
  MOBILE_PRODUCT_VERSION,
  MOBILE_PROTOCOL_MAJOR,
  MOBILE_PROTOCOL_REVISION,
  MOBILE_RELEASE_VERSION,
  MOBILE_SDK_VERSION,
} from "../src/protocol/index.js";

describe("Mobile protocol version contract", () => {
  it("keeps protocol compatibility independent from product and SDK versions", () => {
    expect(MOBILE_PRODUCT_VERSION).toBe(MOBILE_RELEASE_VERSION);
    expect(MOBILE_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isCompatibleProtocolVersion(MOBILE_PROTOCOL_MAJOR)).toBe(true);
    expect(isCompatibleProtocolVersion(MOBILE_PROTOCOL_MAJOR + 1)).toBe(false);
    expect(MOBILE_PROTOCOL_REVISION).toBeGreaterThanOrEqual(0);
  });

  it("accepts additive diagnostic versions during the handshake", () => {
    expect(isProtocolHello({
      type: "protocol_hello",
      protocolVersion: MOBILE_PROTOCOL_MAJOR,
      protocolRevision: MOBILE_PROTOCOL_REVISION,
      sdkVersion: "9.9.9",
      clientVersion: "8.8.8",
      releaseVersion: "7.7.7",
      capabilities: [],
      requestId: "hello-1",
    })).toBe(true);
  });

  it("retains exact release matching only for the legacy bridge helper", () => {
    expect(isCompatibleReleaseVersion(MOBILE_RELEASE_VERSION)).toBe(true);
    expect(isCompatibleReleaseVersion("9.9.9")).toBe(false);
  });
});

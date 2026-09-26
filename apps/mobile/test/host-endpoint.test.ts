import { describe, expect, it } from "vitest";
import { parseHostEndpoint } from "../src/host-endpoint.js";

describe("parseHostEndpoint", () => {
  it("uses the default port for a bare host", () => {
    expect(parseHostEndpoint("127.0.0.1")).toEqual({ host: "127.0.0.1", port: 4739 });
  });

  it("preserves an explicit host port for isolated E2E hosts", () => {
    expect(parseHostEndpoint("127.0.0.1:48391")).toEqual({ host: "127.0.0.1", port: 48391 });
  });

  it("supports bracketed IPv6 hosts", () => {
    expect(parseHostEndpoint("[::1]:48391")).toEqual({ host: "::1", port: 48391 });
  });

  it("rejects invalid endpoints", () => {
    expect(() => parseHostEndpoint("127.0.0.1:0")).toThrow();
    expect(() => parseHostEndpoint("127.0.0.1:70000")).toThrow();
    expect(() => parseHostEndpoint("")).toThrow();
  });
});

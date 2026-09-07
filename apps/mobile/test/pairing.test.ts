import { describe, expect, it } from "vitest";
import { extractPairing } from "../src/pairing.js";

describe("pairing.extractPairing", () => {
  it("解析裸 ws URL（host 端 qr 命令输出格式）", () => {
    const info = extractPairing("ws://192.168.1.5:4739/ws?token=mstro_abc123");
    expect(info).not.toBeNull();
    expect(info!.hostUrl).toBe("ws://192.168.1.5:4739/ws");
    expect(info!.token).toBe("mstro_abc123");
    expect(info!.displayHost).toBe("192.168.1.5:4739");
  });

  it("解析 maestro-mobile://pair scheme", () => {
    const info = extractPairing("maestro-mobile://pair?ws=ws://10.0.0.2:4739/ws&token=tok_42");
    expect(info).not.toBeNull();
    expect(info!.hostUrl).toBe("ws://10.0.0.2:4739/ws");
    expect(info!.token).toBe("tok_42");
  });

  it("无 token 的 ws URL（host 未启用鉴权）", () => {
    const info = extractPairing("ws://192.168.1.5:4739/ws");
    expect(info).not.toBeNull();
    expect(info!.token).toBeUndefined();
  });

  it("wss URL 保持协议", () => {
    const info = extractPairing("wss://host.example.com/ws?token=t");
    expect(info!.hostUrl).toBe("wss://host.example.com/ws");
  });

  it("拒绝非配对内容", () => {
    expect(extractPairing("https://example.com")).toBeNull();
    expect(extractPairing("hello world")).toBeNull();
    expect(extractPairing("")).toBeNull();
    expect(extractPairing("maestro-mobile://pair")).toBeNull(); // 缺 ws 参数
    expect(extractPairing("ftp://x/y")).toBeNull();
  });

  it("容忍首尾空白", () => {
    const info = extractPairing("  ws://192.168.1.5:4739/ws?token=t  \n");
    expect(info!.displayHost).toBe("192.168.1.5:4739");
  });
});

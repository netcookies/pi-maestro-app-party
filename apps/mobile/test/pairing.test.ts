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

describe("pairing.ips 多候选解析", () => {
  it("scheme 带 ips= 解析候选列表（首候选 + 列表去重）", () => {
    const raw = "maestro-mobile://pair?ws=ws%3A%2F%2F192.168.1.5%3A4739%2Fws&token=t&ips=" + encodeURIComponent("192.168.1.5,10.0.0.2,100.77.76.105");
    const info = extractPairing(raw);
    expect(info!.candidateIps).toEqual(["192.168.1.5", "10.0.0.2", "100.77.76.105"]);
    expect(info!.port).toBe("4739");
  });

  it("裸 ws URL 无 ips → 候选仅自身", () => {
    const info = extractPairing("ws://10.0.0.9:4739/ws?token=t");
    expect(info!.candidateIps).toEqual(["10.0.0.9"]);
  });

  it("ips 里的非法项被过滤", () => {
    const raw = "maestro-mobile://pair?ws=ws%3A%2F%2F1.2.3.4%3A4739%2Fws&token=t&ips=" + encodeURIComponent("1.2.3.4,not-an-ip,5.6.7.8");
    const info = extractPairing(raw);
    expect(info!.candidateIps).toEqual(["1.2.3.4", "5.6.7.8"]);
  });
});

describe("pairing.两段式短码", () => {
  it("解析 ?c=&ip=&port= 形态（v0.2.7 短码）", () => {
    const raw = "maestro-mobile://pair?c=AB3D5K7M&ip=172.30.30.17&port=4739";
    const info = extractPairing(raw);
    expect(info!.shortCode).toBe("AB3D5K7M");
    expect(info!.hostUrl).toBe("ws://172.30.30.17:4739/ws");
    expect(info!.candidateIps).toEqual(["172.30.30.17"]);
    expect(info!.token).toBeUndefined();
  });

  it("短码形态缺 c 或 ip 无效 → null", () => {
    expect(extractPairing("maestro-mobile://pair?ip=1.2.3.4&port=4739")).toBeNull();
    expect(extractPairing("maestro-mobile://pair?c=CODE&ip=not-an-ip&port=4739")).toBeNull();
  });

  it("token 形态不被误判为短码", () => {
    const info = extractPairing("maestro-mobile://pair?ws=ws%3A%2F%2F1.2.3.4%3A4739%2Fws&token=t");
    expect(info!.shortCode).toBeUndefined();
    expect(info!.token).toBe("t");
  });
});

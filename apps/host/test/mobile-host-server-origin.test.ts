import { describe, expect, it, afterEach } from "vitest";
import { MobileHostServer } from "../src/server/mobile-host-server.js";
import { HostController } from "../src/host-controller.js";
import { MaestroStateReader } from "../src/maestro-state.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * ISS-20260910-005：isOriginAllowed 的 scheme / port 判定白盒回归。
 *
 * 为什么白盒：Origin 规则是纯字符串判定，走真实 upgrade 只能得到 200/403，
 * 无法区分「被 scheme 拦」还是「被 hostname/端口拦」，而 scheme 与 port 正是本次改的两点。
 * 端到端形态（真实 403 / 放行）由 mobile-host-server-security.test.ts 覆盖。
 *
 * 反向验证（已实测，两个变体各自回滚）：
 *   - 去掉 scheme 限定 → “非 http/https/ws/wss 一律拒绝”挂：file://127.0.0.1 旧实现返回 true
 *   - 同源比较回到 HEAD 的 `hostname === hostHeader || …` → “端口不一致不得靠同源放行”挂：
 *     Origin 带端口 + Host 头不带端口时 HEAD 误判为同源（NEW 只看 parsed.host）
 *   - boundHost 不做 IPv6 括号归一 → IPv6 用例挂（实测 HEAD："[fd00::42]" === "fd00::42" 为 false）
 *   - allowedOrigins 只吃完整 URL → “裸 hostname 写法生效”挂（实测 new URL("a.example.com") 抛错）
 *
 * 注：本节曾写着“HEAD 的 `${hostname}:${port}` 尾冒号永不匹配 ⇒ 无端口同源为 false”，
 * 该推断已被实测推翻：HEAD 同一条件里还有 `hostHeader === hostname` 兜底，该组合仍返回 true。
 * 尾冒号分支确实无效果，但不是该行为的成因；真正的收紧差在“Origin 带端口 / Host 头不带”。
 */

const created: { server: MobileHostServer; controller: HostController; tmpDir: string }[] = [];

async function makeServer(options: { allowedOrigins?: string[] } = {}, boundHost = "0.0.0.0") {
  const tmpDir = join(tmpdir(), `maestro-origin-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  const controller = new HostController(
    { createRuntime: async () => { throw new Error("Not implemented in test"); }, listSessions: async () => [] },
    new MaestroStateReader({ projectRoot: tmpDir }),
  );
  const server = new MobileHostServer(controller, options);
  // 必须真实 listen：否则 close() 抛 "Server is not running"，afterEach 会把整批用例带崩。
  // 绑定地址随后被覆盖成用例要模拟的网卡（192.168.1.50 / fd00::42 等本机未必存在，不能直接 listen）。
  await server.listen(0, "127.0.0.1");
  (server as unknown as { boundHost: string }).boundHost = boundHost;
  created.push({ server, controller, tmpDir });
  return (origin: string | undefined, requestHost = ""): boolean =>
    (server as unknown as {
      isOriginAllowed(origin: string | undefined, requestHost?: string): boolean;
    }).isOriginAllowed(origin, requestHost);
}

afterEach(async () => {
  // 关闭本用例创建的全部 server：同一条 it 里可能 makeServer 多次，
  // 只清最后一个会泄漏真实 socket 并让 vitest worker 挂住
  while (created.length) {
    const c = created.pop()!;
    await c.server.close();
    await c.controller.dispose();
    await rm(c.tmpDir, { recursive: true, force: true });
  }
});

describe("Origin scheme 限定（ISS-005）", () => {
  it("http/https/ws/wss 四种已知 scheme 正常参与判定", async () => {
    const check = await makeServer();
    for (const scheme of ["http", "https", "ws", "wss"]) {
      expect(check(`${scheme}://127.0.0.1:4739`), `${scheme} 应被认`)
        .toBe(true);
    }
  });

  it("非 http/https/ws/wss 的 scheme 一律拒绝（HEAD 实现会放行）", async () => {
    const check = await makeServer({ allowedOrigins: ["http://trusted.example.com"] });
    // HEAD 期望：以下全部 true —— 旧实现完全不看 protocol，hostname 对上就放行
    expect(check("file://127.0.0.1/etc/passwd")).toBe(false);
    expect(check("ftp://trusted.example.com")).toBe(false);
    expect(check("chrome-extension://abcdefghijklmnop")).toBe(false);
  });

  it("无法解析的 Origin 仍拒绝（回归保护）", async () => {
    const check = await makeServer();
    expect(check("null")).toBe(false); // 实测 new URL("null") 抛 Invalid URL
    expect(check("not a url")).toBe(false);
  });

  it("无 Origin 放行路径未改动（RN/原生客户端不发 Origin）", async () => {
    const check = await makeServer();
    expect(check(undefined)).toBe(true);
    expect(check("")).toBe(true);
  });
});

describe("Origin port 参与同源比较（ISS-005）", () => {
  it("Origin 无端口 + Host 头无端口：同源成立", async () => {
    const check = await makeServer();
    expect(check("http://192.168.1.10", "192.168.1.10")).toBe(true);
  });

  it("Origin 与 Host 头端口一致时同源", async () => {
    const check = await makeServer();
    expect(check("http://192.168.1.10:4739", "192.168.1.10:4739")).toBe(true);
    expect(check("ws://10.20.35.123:4739", "10.20.35.123:4739")).toBe(true); // RN OkHttp 形态
  });

  it("端口不一致时不得靠同源分支放行（HEAD 的 hostname-only 兜底会误放）", async () => {
    const check = await makeServer();
    // 关键区分点（实测）：Origin 带非默认端口、Host 头不带端口
    //   HEAD: hostHeader === hostname → true（忽略端口，同源判定被绕过）
    //   NEW : 只比 parsed.host → false
    expect(check("http://192.168.1.10:9999", "192.168.1.10")).toBe(false);
    expect(check("http://192.168.1.10:9999", "192.168.1.10:4739")).toBe(false);
    expect(check("http://192.168.1.10", "192.168.1.10:4739")).toBe(false);
  });

  it("无端口的 Origin 与无端口的 Host 头仍同源（不得把收紧改成过紧）", async () => {
    const check = await makeServer();
    // 实测 new URL("http://192.168.1.10").host === "192.168.1.10"（无尾冒号）
    expect(check("http://192.168.1.10", "192.168.1.10")).toBe(true);
    expect(check("http://192.168.1.10:80", "192.168.1.10")).toBe(true); // :80 被 URL 规范化掉
  });

  it("默认端口被 URL 规范化，不算跨端口", async () => {
    // 实测 new URL("https://a.example:443").port === ""（与不带端口同形）
    const check = await makeServer({ allowedOrigins: ["https://trusted.example.com"] });
    expect(check("https://trusted.example.com:443")).toBe(true);
    expect(check("https://trusted.example.com")).toBe(true);
  });

  it("IPv6 形态：Origin hostname 带括号，与 Host 头/boundHost 归一后比较", async () => {
    const check1 = await makeServer({}, "0.0.0.0");
    expect(check1("http://[fd00::42]:4739", "[fd00::42]:4739")).toBe(true);
    const check2 = await makeServer({}, "fd00::42");
    // boundHost 无括号、Origin hostname 有括号 ⇒ 必须归一
    // （实测 HEAD 直接字符串比较："[fd00::42]" === "fd00::42" 为 false ⇒ 绑定 IPv6 网卡时误拒）
    expect(check2("http://[fd00::42]:4739")).toBe(true);
    expect(check2("http://[fd00::42]")).toBe(true);
    expect(check2("http://[fd00::99]:4739")).toBe(false);
  });
});

describe("allowedOrigins 配置解析（ISS-005）", () => {
  it("裸 hostname 写法生效（HEAD 只吃完整 URL ⇒ 配置静默失效）", async () => {
    const check = await makeServer({ allowedOrigins: ["trusted.example.com"] });
    // HEAD 期望 false：new URL("trusted.example.com") 实测抛 Invalid URL → catch 返回 false
    expect(check("http://trusted.example.com")).toBe(true);
    expect(check("https://trusted.example.com")).toBe(true);
  });

  it("完整 URL 写法仍生效（向后兼容既有配置）", async () => {
    const check = await makeServer({ allowedOrigins: ["https://trusted.example.com"] });
    expect(check("https://trusted.example.com")).toBe(true);
    expect(check("https://other.example.com")).toBe(false);
  });

  it("条目显式带端口时端口必须相等；不带端口则只认 hostname", async () => {
    const strict = await makeServer({ allowedOrigins: ["https://precise.example.com:8443"] });
    expect(strict("https://precise.example.com:8443")).toBe(true);
    expect(strict("https://precise.example.com:9999")).toBe(false);
    expect(strict("https://precise.example.com")).toBe(false); // Origin 无端口 ⇒ port ""，不等于 8443
    const loose = await makeServer({ allowedOrigins: ["https://loose.example.com"] });
    expect(loose("https://loose.example.com:3000")).toBe(true); // 条目未指定端口 ⇒ 只认 hostname
  });

  it("裸 hostname:port 写法可解析（端口不被当成 protocol 分隔符）", async () => {
    const check = await makeServer({ allowedOrigins: ["app.example.com:3000"] });
    expect(check("https://app.example.com:3000")).toBe(true);
    expect(check("https://app.example.com:3001")).toBe(false);
  });

  it("F-004：裸 IPv6 条目不被误切成端口（旧实现 entryHost 变 \"fd00\" 永不匹配）", async () => {
    const check = await makeServer({ allowedOrigins: ["fd00::42"] });
    // 旧实现：entry.indexOf(':') 命中第一个冒号 ⇒ entryHost="fd00" ⇒ 恒 false
    expect(check("http://[fd00::42]:4739")).toBe(true);
    expect(check("http://[fd00::99]:4739")).toBe(false);
  });

  it("F-004：带括号 + 端口的裸 IPv6 条目按端口精确匹配", async () => {
    const check = await makeServer({ allowedOrigins: ["[fd00::42]:4739"] });
    expect(check("http://[fd00::42]:4739")).toBe(true);
    expect(check("http://[fd00::42]:9999")).toBe(false);
  });

  it("大小写与首尾空白不影响匹配", async () => {
    const check = await makeServer({ allowedOrigins: ["  Trusted.Example.COM  "] });
    expect(check("https://trusted.example.com")).toBe(true);
    expect(check("https://TRUSTED.EXAMPLE.COM")).toBe(true); // Origin hostname 已被 URL 小写化
  });

  it("空条目与非法条目不参与匹配、不抛", async () => {
    const check = await makeServer({ allowedOrigins: ["", "   ", "http://[broken", "ok.example.com"] });
    expect(check("https://ok.example.com")).toBe(true);
    expect(check("https://evil.example.com")).toBe(false);
  });
});

describe("Origin 既有放行形态未回归（ISS-005 硬约束）", () => {
  it("loopback 各变体忽略端口放行（纳 port 会打断本地开发页面）", async () => {
    const check = await makeServer();
    expect(check("http://localhost:3000")).toBe(true);
    expect(check("http://127.0.0.1:9999")).toBe(true);
    expect(check("http://[::1]:1234")).toBe(true);
  });

  it("boundHost 命中放行，且 0.0.0.0/:: 不作为白名单", async () => {
    const lan = await makeServer({}, "192.168.1.50");
    expect(lan("http://192.168.1.50:4739")).toBe(true);
    expect(lan("http://192.168.1.51:4739")).toBe(false);
    const any = await makeServer({}, "0.0.0.0");
    expect(any("http://0.0.0.0:4739")).toBe(false); // 绑定所有网卡时不得据此放行
    const any6 = await makeServer({}, "::");
    expect(any6("http://[::]:4739")).toBe(false);
  });

  it("陌生外部 Origin 仍被拒", async () => {
    const check = await makeServer();
    expect(check("https://evil.example.com")).toBe(false);
    expect(check("http://10.0.0.5:4739")).toBe(false);
  });
});

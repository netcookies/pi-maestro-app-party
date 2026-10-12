import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maestroFlowWarning } from "../src/flow-dependency.js";
import maestroHostExtension from "../src/extension.js";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => "/maestro-mobile-dependency-test-no-user-files",
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("../src/notification-tui.js", () => ({ runNotificationTui: vi.fn() }));

const dirs: string[] = [];

async function fixture(options: { version?: unknown; contracts?: boolean; name?: string; root?: string; badSymbol?: boolean } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "mobile-flow-dependency-"));
  if (!options.root) dirs.push(root);
  await mkdir(join(root, "src", "extension"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: options.name ?? "pi-maestro-flow",
    version: "version" in options ? options.version : "0.32.1",
    exports: options.contracts === false ? {} : {
      "./ask-transport": "./src/ask-transport.ts",
      "./plan-transport": "./src/plan-transport.ts",
    },
  }));
  for (const kind of ["ask", "plan"]) {
    const title = kind === "ask" ? "Ask" : "Plan";
    await writeFile(join(root, "src", `${kind}-transport.ts`), [
      `const key = Symbol.for("pi-maestro-flow.${kind}-transports${options.badSymbol ? ".v2" : ""}");`,
      `export function register${title}Transport(transport) { return () => {}; }`,
      `export function get${title}Transports() { return []; }`,
    ].join("\n"));
  }
  return root;
}

function loaded(root?: string, options: { ask?: boolean; plan?: boolean; planRoot?: string } = {}) {
  const sourceInfo = (path: string) => ({ path, source: "npm:pi-maestro-flow", scope: "user", origin: "package" });
  return {
    getAllTools: () => root && options.ask !== false ? [{ name: "ask-user-question", sourceInfo: sourceInfo(join(root, "src", "extension", "index.ts")) }] : [],
    getCommands: () => root && options.plan !== false ? [{ name: "plan", sourceInfo: sourceInfo(join(options.planRoot ?? root, "src", "extension", "index.ts")) }] : [],
  } as unknown as Parameters<typeof maestroFlowWarning>[0];
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loaded Flow dependency contract", () => {
  it("warns for missing or disabled Flow without trusting a global installation or plugin registries", async () => {
    const installed = await fixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", installed);
    const symbol = Symbol.for("pi-maestro-flow.ask-transports");
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const previous = globals[symbol];
    globals[symbol] = { transports: [{ open: () => undefined }] };
    try {
      expect(await maestroFlowWarning(loaded())).toContain("未加载");
    } finally {
      if (previous === undefined) delete globals[symbol];
      else globals[symbol] = previous;
    }
  });

  it.each(["0.30.0", "0.31.2", "0.32.1", "1.0.0+patched"])("accepts %s only when the required transport contract is present", async (version) => {
    expect(await maestroFlowWarning(loaded(await fixture({ version })))).toBeUndefined();
  });

  it.each(["0.30.0", "0.31.2", "0.32.1"])("warns for old or incompatible %s without public transport exports", async (version) => {
    expect(await maestroFlowWarning(loaded(await fixture({ version, contracts: false })))).toContain("旧版或不兼容");
  });

  it.each([undefined, 321, "", "dev", "0.32.1junk", "0.32.1-rc.1"])("warns for malformed or unverified prerelease %s", async (version) => {
    expect(await maestroFlowWarning(loaded(await fixture({ version })))).toContain("版本无效");
  });

  it("rejects a different registry contract, a partial load and colliding commands", async () => {
    expect(await maestroFlowWarning(loaded(await fixture({ badSymbol: true })))).toContain("旧版或不兼容");
    const root = await fixture();
    expect(await maestroFlowWarning(loaded(root, { plan: false }))).toContain("未同时提供");
    expect(await maestroFlowWarning(loaded(root, { planRoot: await fixture() }))).toContain("未同时提供");
    expect(await maestroFlowWarning(loaded(await fixture({ name: "not-flow" })))).toContain("不是可验证");
  });

  it.each(["custom-agent/npm/node_modules/pi-maestro-flow", "project/.pi/npm/node_modules/pi-maestro-flow", "local source with spaces/flow"])("uses the loaded source at %s instead of resolving installations itself", async (path) => {
    const parent = await mkdtemp(join(tmpdir(), "mobile-flow-path-"));
    dirs.push(parent);
    const root = await fixture({ root: join(parent, path) });
    vi.stubEnv("PI_CODING_AGENT_DIR", join(parent, "unrelated-agent"));
    expect(await maestroFlowWarning(loaded(root))).toBeUndefined();
  });

  it("rechecks packages on every invocation and fails softly for unreadable manifests/APIs", async () => {
    const root = await fixture();
    const pi = loaded(root);
    expect(await maestroFlowWarning(pi)).toBeUndefined();
    await writeFile(join(root, "package.json"), "{");
    expect(await maestroFlowWarning(pi)).toContain("不是可验证");
    expect(await maestroFlowWarning({ getAllTools: () => { throw new Error("unavailable"); }, getCommands: () => [] })).toContain("无法验证");
  });

  it("does not follow a transport export outside the loaded package", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-maestro-flow", version: "0.32.1", exports: { "./ask-transport": "./../ask-transport.ts", "./plan-transport": "./src/plan-transport.ts" } }));
    expect(await maestroFlowWarning(loaded(root))).toContain("缺少兼容");
  });
});

describe("actual /maestro-mobile command warning ordering", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.endsWith("/api/health") ? "" : JSON.stringify({ version: "test" }), { status: 200 })));
  });

  async function command(root?: string) {
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    const events: string[] = [];
    const pi = {
      ...loaded(root),
      on: vi.fn(),
      registerCommand: (_name: string, spec: { handler: typeof handler }) => { handler = spec.handler; },
    };
    maestroHostExtension(pi as never);
    const ctx = { ui: { notify: (message: string, level: string) => events.push(`${level}:${message}`) } };
    return { handler: (args: string) => handler(args, ctx), events };
  }

  it.each(["status", "start", "", "qr", "stop", "notify", "unknown"])("warns before continuing %s without spawning or signalling real processes", async (args) => {
    const { spawn, execFile } = await import("node:child_process");
    const { runNotificationTui } = await import("../src/notification-tui.js");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("must not signal"); });
    const cmd = await command();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementation(async () => {
      expect(cmd.events[0]).toContain("warning:maestro-mobile warning:");
      return new Response("{}", { status: args === "qr" || args === "status" ? 503 : 200 });
    });
    await cmd.handler(args);
    expect(cmd.events[0]).toContain("pi install npm:pi-maestro-flow");
    expect(cmd.events[0]).toContain("/reload");
    if (args === "notify") expect(runNotificationTui).toHaveBeenCalledTimes(1);
    else expect(cmd.events.length).toBeGreaterThan(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("warns every time and still returns normal status", async () => {
    const cmd = await command();
    await cmd.handler("status");
    await cmd.handler("status");
    expect(cmd.events.filter((event) => event.includes("maestro-mobile warning:"))).toHaveLength(2);
    expect(cmd.events.at(-1)).toContain("info:maestro-mobile:");
  });

  it("does not warn when the loaded Flow provides the required contracts", async () => {
    const cmd = await command(await fixture());
    await cmd.handler("start");
    expect(cmd.events).toHaveLength(1);
    expect(cmd.events[0]).toContain("info:maestro-mobile:");
  });
});

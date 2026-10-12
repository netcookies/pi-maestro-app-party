import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isStableFlowVersion } from "./version-detector.js";

const FLOW_PACKAGE = "pi-maestro-flow";
const GUIDANCE = "安装：pi install npm:pi-maestro-flow；升级：pi update npm:pi-maestro-flow。通过 pi config 启用 Flow 的主扩展，在目标 Pi TUI 执行 /reload 或重启。";

/** Only inspect sources Pi actually loaded: settings filters, project trust, local packages,
 * CLI -e and PI_CODING_AGENT_DIR are resolved by Pi, never guessed from global installs.
 * The Mobile plugin itself creates the transport registries, so their existence proves nothing.
 */
export async function maestroFlowWarning(pi: Pick<ExtensionAPI, "getCommands" | "getAllTools">): Promise<string | undefined> {
  try {
    const ask = pi.getAllTools().find((tool) => tool.name === "ask-user-question");
    const plan = pi.getCommands().find((command) => command.name === "plan");
    const sources = [ask?.sourceInfo.path, plan?.sourceInfo.path].filter((path): path is string => typeof path === "string" && isAbsolute(path));
    if (sources.length === 0) return `当前 Pi 会话未加载 pi-maestro-flow（可能未安装或已禁用）；Flow Ask / Plan 功能不可用。${GUIDANCE}`;

    const packages = await Promise.all(sources.map(loadedFlowPackage));
    const loaded = packages.find((pkg) => pkg !== undefined);
    if (!loaded) return `当前 Ask / Plan 来源不是可验证的 pi-maestro-flow；Flow 兼容性无法确认。${GUIDANCE}`;
    const label = typeof loaded.manifest.version === "string" ? `@${loaded.manifest.version}` : "（无有效版本）";
    if (!isStableFlowVersion(loaded.manifest.version)) {
      return `已加载 pi-maestro-flow${label}，版本无效或为尚未验证的预发布版本；Flow 兼容性无法确认。${GUIDANCE}`;
    }
    if (!ask || !plan || packages.length !== 2 || packages.some((pkg) => pkg?.root !== loaded.root)) {
      return `已加载 pi-maestro-flow${label}，但未同时提供同一包的 Ask 工具与 Plan 命令；请检查扩展加载或冲突。${GUIDANCE}`;
    }
    const contracts = await Promise.all((["ask", "plan"] as const).map((kind) => hasTransportContract(loaded, kind)));
    if (contracts.some((supported) => !supported)) {
      return `已加载 pi-maestro-flow${label}，缺少兼容的 Ask / Plan transport（旧版或不兼容包）；手机 Ask / Plan 功能不可用。${GUIDANCE}`;
    }
    return undefined;
  } catch {
    return `无法验证当前 Pi 会话的 pi-maestro-flow 依赖；Flow 兼容性无法确认。${GUIDANCE}`;
  }
}

interface FlowPackage {
  root: string;
  manifest: { name?: unknown; version?: unknown; exports?: Record<string, unknown> };
}

/** Follow an already-loaded extension to its nearest package manifest, at most eight levels.
 * This is not package discovery and does not consult or execute unrelated installations.
 */
async function loadedFlowPackage(extensionPath: string): Promise<FlowPackage | undefined> {
  let root = dirname(extensionPath);
  for (let depth = 0; depth < 8; depth++) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as FlowPackage["manifest"];
      return manifest.name === FLOW_PACKAGE ? { root, manifest } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return undefined;
}

/** Current public contracts are TypeScript source exports sharing these exact symbol registries.
 * Read, never import the package: importing Flow would create state and cannot prove it is enabled.
 */
async function hasTransportContract(pkg: FlowPackage, kind: "ask" | "plan"): Promise<boolean> {
  const target = pkg.manifest.exports?.[`./${kind}-transport`];
  if (typeof target !== "string" || !target.startsWith("./")) return false;
  const path = resolve(pkg.root, target);
  const within = relative(pkg.root, path);
  if (within.startsWith("..") || isAbsolute(within)) return false;
  try {
    const source = await readFile(path, "utf8");
    const title = kind === "ask" ? "Ask" : "Plan";
    return new RegExp(`Symbol\\.for\\(["']pi-maestro-flow\\.${kind}-transports["']\\)`).test(source)
      && new RegExp(`export\\s+function\\s+register${title}Transport\\b`).test(source)
      && new RegExp(`export\\s+function\\s+get${title}Transports\\b`).test(source);
  } catch {
    return false;
  }
}

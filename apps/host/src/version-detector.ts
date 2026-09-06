/**
 * version-detector — 探测 Pi / pi-maestro-flow / Maestro CLI 版本
 *
 * 多路径回退，兼容宿主机与 Docker 两种部署形态：
 * 1. 宿主全局安装：~/.pi/agent/npm/node_modules/<pkg>/package.json（pi 生态扩展）
 * 2. 自身依赖：Node 解析本进程 node_modules 里的包（容器/纯净环境）
 * 3. CLI 执行：execFile("<bin>", ["--version"])（最后兜底，仅在路径探测失败时）
 *
 * 所有探测在 Host 启动时执行一次并缓存，运行中不重复探测。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

export interface ComponentVersions {
  /** Pi coding agent 版本（桌面 TUI 同款） */
  piVersion?: string;
  /** pi-maestro-flow 扩展版本 */
  flowVersion?: string;
  /** Maestro CLI（maestro-flow 全局包）版本 */
  maestroCliVersion?: string;
}

/** package.json 中提取 version（接受字符串或已解析对象；空/异常安全） */
function readPkgVersion(raw: string | { version?: unknown }): string | undefined {
  try {
    const pkg = typeof raw === "string" ? JSON.parse(raw) as { version?: unknown } : raw;
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

async function versionFromPkgPath(pkgPath: string): Promise<string | undefined> {
  try {
    return readPkgVersion(await readFile(pkgPath, "utf8"));
  } catch {
    return undefined;
  }
}

/** pi 扩展目录候选：macOS/Linux 均默认 ~/.pi/agent/npm/node_modules/<pkg> */
function piAgentModulePath(pkgName: string): string {
  return join(homedir(), ".pi", "agent", "npm", "node_modules", pkgName, "package.json");
}

/** execFile 兜底：bin 不存在/超时均返回 undefined（3s 超时，版本命令无 stdin 输入） */
function binVersion(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(bin, ["--version"], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const v = String(stdout).trim().split(/\s+/).pop();
      resolve(v && /^\d/.test(v) ? v : undefined);
    });
    child.on("error", () => resolve(undefined));
  });
}

export class VersionDetector {
  private cache: ComponentVersions | null = null;
  private detecting: Promise<ComponentVersions> | null = null;

  /** 探测（结果缓存；并发调用共享同一次探测） */
  async detect(): Promise<ComponentVersions> {
    if (this.cache) return this.cache;
    if (!this.detecting) {
      this.detecting = this.detectOnce().then((v) => {
        this.cache = v;
        this.detecting = null;
        return v;
      });
    }
    return this.detecting;
  }

  /** 测试注入用：清空缓存 */
  reset(): void {
    this.cache = null;
    this.detecting = null;
  }

  private async detectOnce(): Promise<ComponentVersions> {
    const [piVersion, flowVersion, maestroCliVersion] = await Promise.all([
      this.detectPi(),
      this.detectFlow(),
      this.detectMaestroCli(),
    ]);
    return {
      ...(piVersion ? { piVersion } : {}),
      ...(flowVersion ? { flowVersion } : {}),
      ...(maestroCliVersion ? { maestroCliVersion } : {}),
    };
  }

  /** Pi：自身依赖（host 直接依赖 SDK，最可靠）→ 宿主 ~/.pi 目录 → pi bin */
  private async detectPi(): Promise<string | undefined> {
    return (
      await this.selfDependencyVersion("@earendil-works/pi-coding-agent")
      ?? await versionFromPkgPath(piAgentModulePath("@earendil-works/pi-coding-agent"))
      ?? await binVersion("pi")
    );
  }

  /** pi-maestro-flow：宿主 ~/.pi 目录（扩展安装位置）→ 自身依赖 */
  private async detectFlow(): Promise<string | undefined> {
    return (
      await versionFromPkgPath(piAgentModulePath("pi-maestro-flow"))
      ?? await this.selfDependencyVersion("pi-maestro-flow")
    );
  }

  /** Maestro CLI：npm -g maestro-flow → bin 兜底 */
  private async detectMaestroCli(): Promise<string | undefined> {
    return (
      await this.globalModuleVersion("maestro-flow")
      ?? await binVersion("maestro")
    );
  }

  /** 本进程 node_modules 依赖版本（createRequire 链式向上解析） */
  private selfDependencyVersion(pkgName: string): Promise<string | undefined> {
    return (async () => {
      try {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        return readPkgVersion(require(`${pkgName}/package.json`) as string | { version?: unknown });
      } catch {
        return undefined;
      }
    })();
  }

  /** npm 全局目录探测（macOS homebrew / Linux nvm 路径差异大，仅试常见前缀） */
  private async globalModuleVersion(pkgName: string): Promise<string | undefined> {
    const prefixes = [process.env.PREFIX, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"].filter(Boolean) as string[];
    for (const prefix of prefixes) {
      const v = await versionFromPkgPath(join(prefix, pkgName, "package.json"));
      if (v) return v;
    }
    return undefined;
  }
}

/** 便捷函数：探测全部组件版本（内部自带缓存语义） */
export async function detectComponentVersions(detector: VersionDetector): Promise<ComponentVersions> {
  return detector.detect();
}

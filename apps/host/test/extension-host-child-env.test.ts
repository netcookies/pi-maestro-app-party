import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { hostChildEnv } from "../src/extension.js";

describe("maestro-mobile extension host child environment", () => {
  it("只注入可作为 Node SDK 导入的宿主 Pi 包目录", () => {
    const env = hostChildEnv(4791, { PATH: "/usr/bin", PI_PACKAGE_DIR: "/stale" });

    if (existsSync(join(getPackageDir(), "dist", "index.js"))) {
      expect(env.PI_PACKAGE_DIR).toBe(getPackageDir());
    } else {
      expect(env.PI_PACKAGE_DIR).toBeUndefined();
    }
    expect(env.MAESTRO_MOBILE_PORT).toBe("4791");
    expect(env.PATH).toBe("/usr/bin");
  });
});

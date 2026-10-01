import { describe, expect, it } from "vitest";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { hostChildEnv } from "../src/extension.js";

describe("maestro-mobile extension host child environment", () => {
  it("注入宿主 Pi 包目录、覆盖端口并保留继承环境", () => {
    const env = hostChildEnv(4791, { PATH: "/usr/bin", PI_PACKAGE_DIR: "/stale" });

    expect(env.PI_PACKAGE_DIR).toBe(getPackageDir());
    expect(env.MAESTRO_MOBILE_PORT).toBe("4791");
    expect(env.PATH).toBe("/usr/bin");
  });
});

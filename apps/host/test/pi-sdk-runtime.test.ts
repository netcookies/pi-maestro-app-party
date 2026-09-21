import { beforeEach, describe, expect, it, vi } from "vitest";

const { list, listAll } = vi.hoisted(() => ({
  list: vi.fn(),
  listAll: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionRuntime: vi.fn(),
  createAgentSessionServices: vi.fn(),
  getAgentDir: vi.fn(),
  SessionManager: {
    list,
    listAll,
    create: vi.fn(),
    open: vi.fn(),
    continueRecent: vi.fn(),
  },
}));

import { PiSdkRuntimeFactory } from "../src/pi/pi-sdk-runtime.js";

describe("PiSdkRuntimeFactory", () => {
  beforeEach(() => {
    list.mockReset();
    listAll.mockReset();
    list.mockResolvedValue([]);
    listAll.mockResolvedValue([]);
  });

  it("scopes the default session listing to the Host project root", async () => {
    const projectRoot = "/work/project";
    const factory = new PiSdkRuntimeFactory(projectRoot);

    await expect(factory.listSessions()).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith(projectRoot);
    expect(listAll).not.toHaveBeenCalled();
  });

  it("preserves an explicit cwd for targeted session listing", async () => {
    const factory = new PiSdkRuntimeFactory("/work/project");

    await factory.listSessions("/work/other");
    expect(list).toHaveBeenCalledWith("/work/other");
    expect(listAll).not.toHaveBeenCalled();
  });
});

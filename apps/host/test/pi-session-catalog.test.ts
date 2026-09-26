import { beforeEach, describe, expect, it, vi } from "vitest";

const { list, create, open, continueRecent } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  continueRecent: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list, create, open, continueRecent },
}));

import { PiSessionCatalog } from "../src/pi/pi-sdk-runtime.js";

describe("PiSessionCatalog", () => {
  beforeEach(() => {
    list.mockReset();
    create.mockReset();
    open.mockReset();
    continueRecent.mockReset();
    list.mockResolvedValue([]);
  });

  it("lists existing sessions in the Host project root", async () => {
    const catalog = new PiSessionCatalog("/work/project");

    await expect(catalog.listSessions()).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith("/work/project");
    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(continueRecent).not.toHaveBeenCalled();
  });

  it("passes an explicit cwd to SessionManager.list without opening a session", async () => {
    const catalog = new PiSessionCatalog("/work/project");

    await catalog.listSessions("/work/other");
    expect(list).toHaveBeenCalledWith("/work/other");
    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(continueRecent).not.toHaveBeenCalled();
  });
});

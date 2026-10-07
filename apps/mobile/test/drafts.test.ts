import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { storage.set(key, value); },
    removeItem: async (key: string) => { storage.delete(key); },
  },
}));

import { clearDraft, draftKey, draftScopeKey, loadDraft, saveDraft } from "../src/drafts.js";

describe("session drafts", () => {
  beforeEach(() => storage.clear());

  it("isolates host, session, and exact target scopes", async () => {
    const first = draftScopeKey("ws://host-a", "session", "target-a");
    const second = draftScopeKey("ws://host-a", "session", "target-b");
    await saveDraft(first, "draft-a");
    expect(await loadDraft(first)).toBe("draft-a");
    expect(await loadDraft(second)).toBe("");
    expect(draftKey(first)).not.toBe(draftKey(draftScopeKey("ws://host-b", "session", "target-a")));
  });

  it("serializes writes and clears only the selected scope", async () => {
    const first = draftScopeKey("ws://host", "session", "target");
    const second = draftScopeKey("ws://host", "session", "other");
    await Promise.all([saveDraft(first, "one"), saveDraft(first, "two")]);
    await saveDraft(second, "keep");
    expect(await loadDraft(first)).toBe("two");
    await clearDraft(first);
    expect(await loadDraft(first)).toBe("");
    expect(await loadDraft(second)).toBe("keep");
  });
});

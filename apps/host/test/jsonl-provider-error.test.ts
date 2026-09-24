import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayTailFromJsonl } from "../src/jsonl-pager.js";

describe("JSONL provider error projection", () => {
  it("retains SDK stopReason/errorMessage on history replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jsonl-provider-error-"));
    try {
      const file = join(dir, "session.jsonl");
      await writeFile(file, JSON.stringify({ type: "message", message: {
        role: "assistant", content: [], timestamp: 1756800100000, stopReason: "error",
        errorMessage: 'Error: provider-x API error (500): {"message":"failed","type":"bad_response_status_code","code":"bad_status"}',
      } }) + "\n");
      const result = await replayTailFromJsonl(file, 10);
      expect(result.items).toContainEqual(expect.objectContaining({
        text: "failed", status: "failed", error: expect.objectContaining({ source: "provider", provider: "provider-x", httpStatus: 500, code: "bad_status", type: "bad_response_status_code" }),
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

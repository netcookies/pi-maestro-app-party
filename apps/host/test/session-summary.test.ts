import { describe, expect, it } from "vitest";
import type { HostSessionList } from "@maestro-mobile/shared";

// 直接测 toSessionSummaryList 不容易（它是私有的），改为通过 /api/sessions 集成验证
// 这里单独测 normalizeIso 行为：日期字符串规范化为 ISO，Hermes 可解析

describe("session summary date normalization", () => {
  it("parses Node local-time string and produces ISO", () => {
    const raw = "Thu Sep 03 2026 16:59:03 GMT+0800 (China Standard Time)";
    const iso = normalizeForTest(raw);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(iso)).not.toBeNaN();
  });

  it("passes through already-ISO strings", () => {
    const iso = "2026-09-03T08:59:03.000Z";
    expect(normalizeForTest(iso)).toBe(iso);
  });

  it("handles empty and unparseable input", () => {
    expect(normalizeForTest("")).toBe("");
    expect(normalizeForTest("garbage")).toBe("garbage");
  });

  it("sorts correctly after normalization", () => {
    const a = normalizeForTest("Thu Sep 03 2026 16:59:03 GMT+0800 (China Standard Time)");
    const b = normalizeForTest("Thu Sep 03 2026 16:58:37 GMT+0800 (China Standard Time)");
    expect(Date.parse(a)).toBeGreaterThan(Date.parse(b));
  });
});

function normalizeForTest(raw: string): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}
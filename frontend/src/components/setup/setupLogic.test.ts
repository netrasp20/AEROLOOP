import { describe, expect, it } from "vitest";

import { summaryBadge, summarizeStatus } from "./setupLogic";
import type { SetupStatusItem, SetupTone } from "./setupLogic";

function item(id: string, tone: SetupTone): SetupStatusItem {
  return { id, label: id, tone, message: "m", nav: "summary" };
}

describe("summarizeStatus", () => {
  it("tallies all five tones", () => {
    const items = [
      item("a", "good"),
      item("b", "good"),
      item("c", "warn"),
      item("d", "unsupported"),
      item("e", "unknown"),
      item("f", "waiting"),
    ];
    const summary = summarizeStatus(items);
    expect(summary).toEqual({ good: 2, warn: 1, unsupported: 1, unknown: 1, waiting: 1 });
  });

  it("sums to the item count", () => {
    const items = [item("a", "good"), item("b", "waiting"), item("c", "unknown")];
    const summary = summarizeStatus(items);
    expect(Object.values(summary).reduce((a, b) => a + b, 0)).toBe(items.length);
  });
});

describe("summaryBadge", () => {
  it("maps warn + unsupported to the SetupNav badge shape", () => {
    expect(
      summaryBadge({ good: 9, warn: 2, unsupported: 1, unknown: 0, waiting: 0 })
    ).toEqual({ warn: 2, bad: 1 });
  });

  it("ignores waiting and unknown — unresolved is not a configuration problem", () => {
    expect(
      summaryBadge({ good: 0, warn: 0, unsupported: 0, unknown: 5, waiting: 10 })
    ).toEqual({ warn: 0, bad: 0 });
  });
});
import { describe, expect, it } from "vitest";
import { formatCompassStatus } from "./setupSensorFormat";

describe("formatCompassStatus", () => {
  it("labels known statuses", () => {
    expect(formatCompassStatus("not-started", 0)).toBe("Not started");
    expect(formatCompassStatus("success", 100)).toBe("Finished — accept the result");
  });

  it("appends percentage while rotating", () => {
    expect(formatCompassStatus("running-step-one", 55)).toBe("Rotating… (55%)");
    expect(formatCompassStatus("running-step-two", 20)).toBe("Rotating… (20%)");
  });

  it("returns the raw token for unknown statuses", () => {
    expect(formatCompassStatus("mystery", 0)).toBe("mystery");
  });
});
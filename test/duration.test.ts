import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/webview/duration.js";

describe("duration formatting", () => {
  it("uses compact units at millisecond, second, and minute boundaries", () => {
    expect(formatDuration(0.4)).toBe("<1ms");
    expect(formatDuration(130)).toBe("130ms");
    expect(formatDuration(1_001)).toBe("1s1ms");
    expect(formatDuration(61_999)).toBe("1m1s");
  });
});

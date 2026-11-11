import { describe, expect, it } from "vitest";
import {
  composeVideoAnnotationText, formatTimecode, parseFrameMarks, planContextFrames, snapFrameKey,
  type PlannedFrame
} from "../src/features/conversations/browser/videoAnnotation.js";

const times = (plan: readonly PlannedFrame[]): number[] => plan.map((frame) => frame.timeMs);
const roles = (plan: readonly PlannedFrame[]): string[] => plan.map((frame) => frame.role);

describe("formatTimecode", () => {
  it("writes hours, minutes, seconds and milliseconds", () => {
    expect(formatTimecode(0)).toBe("00:00:00.000");
    expect(formatTimecode(12_400)).toBe("00:00:12.400");
    expect(formatTimecode(3_600_000)).toBe("01:00:00.000");
    expect(formatTimecode(3_725_001)).toBe("01:02:05.001");
  });
});

describe("snapFrameKey", () => {
  it("keeps a moment comparable across seeks", () => {
    expect(snapFrameKey(12_400.4)).toBe(12_400);
    expect(snapFrameKey(-5)).toBe(0);
  });
});

describe("parseFrameMarks", () => {
  const frames = [{
    timeMs: 12_400,
    marks: [
      { kind: "region", box: { x: 1, y: 2, width: 3, height: 4 }, note: "wrong label" },
      { kind: "point", point: { x: 5, y: 6 }, note: "" }
    ]
  }];

  it("reads back one marks list per frame", () => {
    expect(parseFrameMarks(JSON.stringify(frames))).toEqual(frames);
  });

  it("drops a stored value that is not a frame, and a frame someone emptied", () => {
    expect(parseFrameMarks("not json")).toEqual([]);
    expect(parseFrameMarks('{"timeMs":1}')).toEqual([]);
    expect(parseFrameMarks(JSON.stringify([
      ...frames,
      null,
      { timeMs: "soon", marks: frames[0]!.marks },
      { timeMs: 900, marks: [] },
      { timeMs: 950, marks: [{ kind: "blob" }] }
    ]))).toEqual(frames);
  });
});

describe("planContextFrames", () => {
  it("gives one mark two seconds either side", () => {
    const plan = planContextFrames({ markTimesMs: [12_000], durationMs: 60_000 });
    expect(times(plan)).toEqual([10_000, 11_000, 12_000, 13_000, 14_000]);
    expect(roles(plan)).toEqual(["context", "context", "mark", "context", "context"]);
  });

  it("fills the gap between two marks one second at a time", () => {
    const plan = planContextFrames({ markTimesMs: [12_000, 22_000], durationMs: 60_000 });
    // Nine frames between the marks, plus the two seconds around each mark.
    expect(times(plan)).toEqual([
      10_000, 11_000, 12_000, 13_000, 14_000, 15_000, 16_000, 17_000, 18_000, 19_000, 20_000,
      21_000, 22_000, 23_000, 24_000
    ]);
    expect(roles(plan).filter((role) => role === "mark")).toHaveLength(2);
  });

  it("never lists one moment twice, and the mark decides the role", () => {
    const plan = planContextFrames({ markTimesMs: [12_000, 13_000], durationMs: 60_000 });
    expect(new Set(times(plan)).size).toBe(times(plan).length);
    expect(plan.filter((frame) => frame.role === "mark").map((frame) => frame.timeMs)).toEqual([12_000, 13_000]);
    expect(times(plan)).toEqual([10_000, 11_000, 12_000, 13_000, 14_000, 15_000]);
  });

  it("keeps every mark and caps the whole plan at 24 frames", () => {
    const marks = [10_000, 70_000, 130_000, 190_000, 250_000];
    const plan = planContextFrames({ markTimesMs: marks, durationMs: 300_000 });
    expect(plan).toHaveLength(24);
    expect(plan.filter((frame) => frame.role === "mark").map((frame) => frame.timeMs)).toEqual(marks);
    // What is left is spread over the video instead of piling up at the front.
    const context = plan.filter((frame) => frame.role === "context").map((frame) => frame.timeMs);
    expect(context.at(-1)! - context[0]!).toBeGreaterThan(200_000);
  });

  it("stays inside a short video and ignores a mark past its end", () => {
    expect(times(planContextFrames({ markTimesMs: [300], durationMs: 1_000 }))).toEqual([300]);
    expect(planContextFrames({ markTimesMs: [5_000], durationMs: 1_000 })).toEqual([]);
    expect(planContextFrames({ markTimesMs: [], durationMs: 1_000 })).toEqual([]);
  });
});

describe("composeVideoAnnotationText", () => {
  it("groups the notes under their frame and lists the context separately", () => {
    const text = composeVideoAnnotationText(".dext/attachments/v.mp4", [
      { timeMs: 12_400, role: "mark", imagePath: ".dext/attachments/a.jpg", marks: [
        { kind: "region", box: { x: 120, y: 340, width: 300, height: 40 }, note: " wrong label" },
        { kind: "point", point: { x: 800, y: 120 }, note: "" }
      ] },
      { timeMs: 10_000, role: "context", imagePath: ".dext/attachments/b.jpg" },
      { timeMs: 13_000, role: "context", imagePath: ".dext/attachments/c.jpg" }
    ]);
    expect(text).toBe([
      "Video annotations for @.dext/attachments/v.mp4 (pixel coordinates per frame, origin top-left):",
      "Frame 00:00:12.400 \u2014 @.dext/attachments/a.jpg:",
      "  1. region (120,340)-(420,380): wrong label",
      "  2. point (800,120)",
      "",
      "Context frames (low resolution, in time order):",
      "- 00:00:10.000 @.dext/attachments/b.jpg",
      "- 00:00:13.000 @.dext/attachments/c.jpg"
    ].join("\n"));
  });

  it("writes only the heading when there is no frame to describe", () => {
    expect(composeVideoAnnotationText(".dext/attachments/v.mp4", []))
      .toBe("Video annotations for @.dext/attachments/v.mp4 (pixel coordinates per frame, origin top-left):");
  });
});

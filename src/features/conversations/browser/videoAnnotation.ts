import { markLine, marksFromValue, type ImageMark } from "./imageAnnotation.js";

/** What one moment of a video keeps between visits: its marks, and the
 * millisecond the video reported for that moment. */
export interface FrameMarks {
  timeMs: number;
  marks: ImageMark[];
}

/** A still Dext exports for the Input. `mark` frames carry the notes, `context`
 * frames are the cheaper stills around them that show what led to them. */
export interface AnnotationFrame {
  timeMs: number;
  role: "mark" | "context";
  /** Attachment reference of the exported still. */
  imagePath: string;
  marks?: readonly ImageMark[];
}

export interface PlannedFrame {
  timeMs: number;
  role: "mark" | "context";
}

/** Each mark gets two seconds of run-up and recovery; adjacent marks are joined
 * at one frame per second, which is the density a native video model samples at
 * anyway. Beyond that, more stills cost tokens without adding causality. */
const CONTEXT_WINDOW_MS = 2000;
const CONTEXT_STEP_MS = 1000;
/** Hard ceiling for one Insert: past this the frame stills cost more attention
 * than the notes they explain. */
export const MAX_PLANNED_FRAMES = 24;

/** `00:00:12.400`: the same shape in the text block and in the frame list. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
}

/** A frame's marks belong to a moment, and a seek lands on that same moment only
 * when both are compared at the precision the video reports. */
export function snapFrameKey(ms: number): number {
  return Math.max(0, Math.round(ms));
}

export function parseFrameMarks(json: string): FrameMarks[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  const frames: FrameMarks[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const record = entry as Record<string, unknown> | undefined;
    if (typeof record?.timeMs !== "number" || !Number.isFinite(record.timeMs)) continue;
    const marks = marksFromValue(record.marks);
    // A frame someone emptied is not worth keeping or exporting.
    if (marks.length) frames.push({ timeMs: snapFrameKey(record.timeMs), marks });
  }
  return frames;
}

/** A kept mark is never dropped for a context frame, however crowded the plan
 * is; the context frames give way evenly instead. */
function evenly(times: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, (times.length - 1) / Math.max(1, count - 1));
  return Array.from({ length: count }, (_, index) => times[Math.round(index * step)]!)
    .filter((time, index, all) => all.indexOf(time) === index);
}

/** Which stills one Insert exports: every marked moment plus the context that
 * makes it explicable, as one time-ordered plan. */
export function planContextFrames(options: {
  markTimesMs: readonly number[];
  durationMs: number;
}): PlannedFrame[] {
  const end = Math.max(0, Math.round(options.durationMs));
  const marks = [...new Set(options.markTimesMs
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= end)
    .map(snapFrameKey))].sort((left, right) => left - right);
  if (!marks.length) return [];
  const context = new Set<number>();
  for (const [index, at] of marks.entries()) {
    for (let offset = -CONTEXT_WINDOW_MS; offset <= CONTEXT_WINDOW_MS; offset += CONTEXT_STEP_MS) {
      const time = at + offset;
      if (time >= 0 && time <= end) context.add(time);
    }
    const next = marks[index + 1];
    if (next !== undefined) {
      for (let time = at + CONTEXT_STEP_MS; time < next; time += CONTEXT_STEP_MS) {
        if (time <= end) context.add(time);
      }
    }
  }
  for (const mark of marks) context.delete(mark);
  const ordered = [...context].sort((left, right) => left - right);
  const room = Math.max(0, MAX_PLANNED_FRAMES - marks.length);
  const kept = ordered.length <= room ? ordered : evenly(ordered, room);
  return [
    ...marks.map((timeMs) => ({ timeMs, role: "mark" as const })),
    ...kept.map((timeMs) => ({ timeMs, role: "context" as const }))
  ].sort((left, right) => left.timeMs - right.timeMs);
}

/** The Input block for a video: the marked frames carry the notes, the context
 * frames are listed in order so an agent reads the run-up before the problem. */
export function composeVideoAnnotationText(videoPath: string, frames: readonly AnnotationFrame[]): string {
  const marked = frames.filter((frame) => frame.role === "mark");
  const context = frames.filter((frame) => frame.role === "context");
  const lines = [`Video annotations for @${videoPath} (pixel coordinates per frame, origin top-left):`];
  for (const frame of marked) {
    lines.push(`Frame ${formatTimecode(frame.timeMs)} \u2014 @${frame.imagePath}:`);
    for (const [index, mark] of (frame.marks ?? []).entries()) lines.push(`  ${markLine(mark, index)}`);
  }
  if (context.length) {
    lines.push("", "Context frames (low resolution, in time order):");
    for (const frame of context) lines.push(`- ${formatTimecode(frame.timeMs)} @${frame.imagePath}`);
  }
  return lines.join("\n");
}

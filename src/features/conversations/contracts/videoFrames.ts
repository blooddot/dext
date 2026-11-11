/** One still cut out of a video: base64 JPEG bytes, no data-URL prefix. */
export interface VideoFrameStill {
  /** The moment the player reported, in milliseconds. */
  timeMs: number;
  data: string;
}

/** What one capture session reports. `frames` is empty when the caller only asked
 * for the video's shape, which is how an agent learns the duration first. */
export interface VideoFrameCapture {
  durationMs: number;
  width: number;
  height: number;
  frames: VideoFrameStill[];
}

/** The name an agent sees. It lives in the contract because the prompt that points
 * an agent at a video has to name the same tool the host registers. */
export const FRAMES_TOOL = "dext_video_frames";

/** One capture's ceiling: past this the stills cost more attention than the video
 * they describe. */
export const MAX_CAPTURED_FRAMES = 12;

/** Long edge of a captured still. A screen recording's text has to stay readable,
 * which is why this sits above the annotator's own context frames. */
export const MAX_FRAME_LONG_EDGE = 1024;

import {
  boxFromPoints, displayToImage, imageBoxToDisplay,
  type DisplayRect, type ImageMark, type ImagePoint
} from "./imageAnnotation.js";
import {
  MAX_PLANNED_FRAMES, composeVideoAnnotationText, formatTimecode, planContextFrames, snapFrameKey,
  type AnnotationFrame, type FrameMarks
} from "./videoAnnotation.js";

export interface VideoAnnotatorOptions {
  /** Attachment reference the composed block points at. */
  path: string;
  /** The attachment's Webview URL; the page fetches it to get a same-origin blob. */
  source: string;
  frames?: readonly FrameMarks[];
  /** Every change, so the tab keeps each frame's marks after it is closed. */
  onFrames?(frames: readonly FrameMarks[]): void;
  onInsert(text: string): void;
  /** Stores one exported still and resolves its attachment reference. */
  storeFrame(data: string, mimeType: string): Promise<string>;
}

/** Below this pointer travel a press is a click, not a hand-drawn box. */
const DRAG_THRESHOLD = 4;
const POINT_SIZE = 18;
const BADGE_HEIGHT = 22;
/** Long edges and quality: a marked frame is read closely, the frames around it
 * only have to show what changed. */
const MARK_EDGE = 768;
const MARK_QUALITY = 0.75;
const CONTEXT_EDGE = 512;
const CONTEXT_QUALITY = 0.6;
/** Until a painted frame has been measured, a frame is assumed to be 1/30 s. */
const DEFAULT_FRAME_MS = 1000 / 30;
/** Same yellow as the overlay's marks, so a still reads like the paused page did. */
const MARK_COLOR = "#ffcc00";

const place = (element: HTMLElement, left: number, top: number, width: number, height: number): void => {
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${Math.max(width, 0)}px`;
  element.style.height = `${Math.max(height, 0)}px`;
};

/** Annotation page for one video attachment: the player is the editor, and each
 * paused moment keeps its own marks. */
export class VideoAnnotator {
  readonly element: HTMLElement;
  private readonly video = document.createElement("video");
  private readonly stage = document.createElement("div");
  private readonly layers = document.createElement("div");
  private readonly preview = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly error = document.createElement("div");
  private readonly play = document.createElement("button");
  private readonly timeline = document.createElement("input");
  private readonly timecode = document.createElement("span");
  private readonly done = document.createElement("button");
  private readonly progress = document.createElement("span");
  /** Marks per frame, keyed by the millisecond the player reported. */
  private readonly frames = new Map<number, ImageMark[]>();
  /** The frame whose marks are being edited. */
  private key: number | undefined;
  private marks: ImageMark[] = [];
  private natural = { width: 0, height: 0 };
  private drag: { from: ImagePoint; client: ImagePoint; pointerId: number } | undefined;
  /** Measured gap between two painted frames; what a step back moves by. */
  private frameMs = DEFAULT_FRAME_MS;
  private lastPaintedMs: number | undefined;
  private busy = false;

  constructor(private readonly options: VideoAnnotatorOptions) {
    this.element = document.createElement("div");
    this.element.className = "video-annotator";

    this.video.className = "video-annotator-video";
    this.video.controls = false;
    this.video.preload = "auto";
    this.stage.className = "video-annotator-stage";
    this.layers.className = "image-annotator-layers";
    this.preview.className = "image-annotator-box image-annotator-drawing";
    this.preview.hidden = true;
    this.layers.append(this.preview);
    this.stage.append(this.video, this.layers);

    this.list.className = "image-annotator-list";
    this.error.className = "image-annotator-error";
    this.error.hidden = true;

    for (const frame of options.frames ?? []) this.frames.set(frame.timeMs, [...frame.marks]);

    this.stage.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.stage.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.stage.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.video.addEventListener("seeked", () => this.syncFrame());
    this.video.addEventListener("timeupdate", () => this.syncFrame());
    this.video.addEventListener("play", () => this.renderTransport());
    this.video.addEventListener("pause", () => this.renderTransport());
    new ResizeObserver(() => this.renderMarks()).observe(this.stage);
    document.addEventListener("keydown", (event) => this.keydown(event));

    this.element.append(this.stage, this.transport(), this.error, this.list, this.actions());
  }

  /** One video per editor tab: the page plays it and annotates it at once. */
  open(): void {
    if (!this.element.isConnected) document.body.append(this.element);
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      if (!this.options.source) throw new Error("This attachment file is missing.");
      // Playing the bytes from a `blob:` keeps the canvas same-origin: a
      // `vscode-webview:` source would taint it and `toDataURL` would throw.
      // shortcut: the whole file lands in webview memory before playback, so a
      // 100 MB video costs that much; stream it and capture on Insert if that hurts.
      const response = await fetch(this.options.source);
      if (!response.ok) throw new Error(`The video could not be read (${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      await new Promise<void>((resolve, reject) => {
        this.video.onloadedmetadata = () => resolve();
        this.video.onerror = () => reject(new Error(
          "This video's codec cannot be decoded in the editor. Convert it to MP4/H.264 and open it again."
        ));
        this.video.src = url;
      });
      this.natural = { width: this.video.videoWidth, height: this.video.videoHeight };
      this.timeline.max = String(Math.max(1, Math.round(this.durationMs())));
      this.done.disabled = false;
      this.syncFrame(true);
      this.renderTransport();
    } catch (failure) {
      this.showError(failure);
    }
  }

  private durationMs(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration * 1000 : 0;
  }

  /** Play/pause, a scrubbable timeline and the timecode: the three things a
   * video needs before anyone can point at a moment in it. */
  private transport(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "video-annotator-transport";
    this.play.type = "button";
    this.play.className = "video-annotator-play";
    this.play.addEventListener("click", () => { void this.togglePlay(); });
    this.timeline.type = "range";
    this.timeline.min = "0";
    this.timeline.step = "1";
    this.timeline.value = "0";
    this.timeline.className = "video-annotator-timeline";
    this.timeline.setAttribute("aria-label", "Playback position");
    this.timeline.addEventListener("input", () => { void this.seekMs(Number(this.timeline.value)); });
    this.timecode.className = "video-annotator-timecode";
    bar.append(this.play, this.timeline, this.timecode);
    return bar;
  }

  private actions(): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "ui-dialog-actions";
    const hint = document.createElement("span");
    hint.className = "video-annotator-hint";
    hint.textContent = "\u2190 \u2192 1 second\nShift+\u2190 \u2192 1 frame";
    this.done.type = "button";
    this.done.textContent = "Insert annotations";
    this.done.disabled = true;
    this.done.addEventListener("click", () => { void this.insert(); });
    this.progress.className = "video-annotator-progress";
    actions.append(hint, this.progress, this.done);
    return actions;
  }

  private async togglePlay(): Promise<void> {
    if (this.video.paused) await this.video.play();
    else this.video.pause();
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // A note field owns its own caret movement.
    if (event.target instanceof HTMLTextAreaElement) return;
    if (event.target instanceof HTMLInputElement && event.target.type === "text") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    void (event.shiftKey
      ? this.stepFrame(direction)
      : this.seekMs(this.video.currentTime * 1000 + direction * 1000));
  }

  /** One frame forward is what the decoder reports as painted; one frame back has
   * no such signal, so it moves by the last measured frame duration. */
  private async stepFrame(direction: 1 | -1): Promise<void> {
    // The last frame has nothing to paint, and waiting for one would hang the key.
    const beforeEnd = this.video.currentTime * 1000 < this.durationMs() - 1;
    if (direction > 0 && beforeEnd && typeof this.video.requestVideoFrameCallback === "function") {
      await this.seekMs(await this.nextPaintedMs());
      return;
    }
    // shortcut: a step back assumes the previous frame lasted as long as the last
    // one measured (1/30 s before one has been). Upgrade if the platform exposes fps.
    await this.seekMs(this.video.currentTime * 1000 + direction * this.frameMs);
  }

  private nextPaintedMs(): Promise<number> {
    const video = this.video;
    return new Promise((resolve) => {
      video.requestVideoFrameCallback((_now, metadata) => {
        const painted = metadata.mediaTime * 1000;
        if (this.lastPaintedMs !== undefined && painted > this.lastPaintedMs) {
          this.frameMs = Math.min(200, Math.max(1, Math.round(painted - this.lastPaintedMs)));
        }
        this.lastPaintedMs = painted;
        video.pause();
        resolve(painted);
      });
      void video.play();
    });
  }

  private seekMs(ms: number): Promise<void> {
    const end = this.durationMs();
    const target = Math.min(Math.max(0, ms), Math.max(0, end - 1));
    if (Math.abs(this.video.currentTime * 1000 - target) < 1) {
      this.syncFrame(true);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        this.video.removeEventListener("seeked", done);
        this.syncFrame(true);
        resolve();
      };
      this.video.addEventListener("seeked", done);
      this.video.currentTime = target / 1000;
    });
  }

  /** Moving the player is also moving to another frame's notes: the frame being
   * left is written back before the next one's are shown. */
  private syncFrame(force = false): void {
    const key = snapFrameKey(this.video.currentTime * 1000);
    if (!force && key === this.key) {
      this.renderTransport();
      return;
    }
    this.commit();
    this.key = key;
    this.marks = this.frames.get(key) ?? [];
    this.renderMarks();
    this.renderRows();
    this.renderTransport();
  }

  private commit(): void {
    if (this.key === undefined) return;
    if (this.marks.length) this.frames.set(this.key, this.marks);
    else this.frames.delete(this.key);
  }

  private save(): void {
    this.commit();
    this.options.onFrames?.(this.savedFrames());
  }

  private savedFrames(): FrameMarks[] {
    return [...this.frames.entries()]
      .filter(([, marks]) => marks.length)
      .map(([timeMs, marks]) => ({ timeMs, marks }))
      .sort((left, right) => left.timeMs - right.timeMs);
  }

  private renderTransport(): void {
    this.play.textContent = this.video.paused ? "\u25b6" : "\u275a\u275a";
    this.play.setAttribute("aria-label", this.video.paused ? "Play" : "Pause");
    this.timeline.value = String(Math.round(this.video.currentTime * 1000));
    this.timecode.textContent = `${formatTimecode(this.video.currentTime * 1000)} / ${formatTimecode(this.durationMs())}`;
  }

  /** The player's own pixel space: the video is fitted, so the overlay and the
   * hand-drawn marks share one rectangle. */
  private displayRect(): DisplayRect {
    const video = this.video.getBoundingClientRect();
    const stage = this.stage.getBoundingClientRect();
    return {
      left: video.left - stage.left,
      top: video.top - stage.top,
      width: video.width,
      height: video.height
    };
  }

  private imagePoint(client: ImagePoint): ImagePoint {
    return displayToImage(this.video.getBoundingClientRect(), this.natural, client);
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.natural.width || this.busy) return;
    event.preventDefault();
    // A moving picture cannot be annotated: the frame would move under the box.
    this.video.pause();
    this.stage.setPointerCapture(event.pointerId);
    this.drag = { from: this.imagePoint(event), client: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId };
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.drag || !this.natural.width) return;
    const rect = imageBoxToDisplay(this.displayRect(), this.natural, boxFromPoints(this.drag.from, this.imagePoint(event)));
    place(this.preview, rect.left, rect.top, rect.width, rect.height);
    this.preview.hidden = false;
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag || !this.natural.width) return;
    const drag = this.drag;
    this.drag = undefined;
    this.preview.hidden = true;
    if (this.stage.hasPointerCapture(drag.pointerId)) this.stage.releasePointerCapture(drag.pointerId);
    const end = this.imagePoint(event);
    if (Math.hypot(event.clientX - drag.client.x, event.clientY - drag.client.y) < DRAG_THRESHOLD) {
      this.marks.push({ kind: "point", point: end, note: "" });
    } else {
      const box = boxFromPoints(drag.from, end);
      if (!box.width || !box.height) return;
      this.marks.push({ kind: "region", box, note: "" });
    }
    this.renderMarks();
    this.save();
    this.renderRows();
    // The row just added is the last one of the frame being edited.
    [...this.list.querySelectorAll<HTMLTextAreaElement>(".video-annotator-frame-group.is-active textarea")].pop()?.focus();
  }

  private highlight(index: number, active: boolean): void {
    this.layers.querySelectorAll(".image-annotator-mark")[index]
      ?.classList.toggle("image-annotator-active", active);
  }

  private renderMarks(): void {
    const display = this.natural.width ? this.displayRect() : undefined;
    const nodes = this.marks.map((mark, index) => {
      const node = document.createElement("div");
      node.className = `image-annotator-mark image-annotator-${mark.kind}`;
      node.dataset.index = String(index);
      const badge = document.createElement("span");
      badge.className = "image-annotator-index";
      badge.textContent = String(index + 1);
      node.append(badge);
      if (display) {
        if (mark.kind === "region") {
          const rect = imageBoxToDisplay(display, this.natural, mark.box);
          place(node, rect.left, rect.top, rect.width, rect.height);
          node.classList.toggle("image-annotator-badge-inside", rect.top < BADGE_HEIGHT);
        } else {
          const rect = imageBoxToDisplay(display, this.natural, { ...mark.point, width: 0, height: 0 });
          place(node, rect.left - POINT_SIZE / 2, rect.top - POINT_SIZE / 2, POINT_SIZE, POINT_SIZE);
        }
      }
      return node;
    });
    this.layers.replaceChildren(this.preview, ...nodes);
  }

  /** The whole video's notes as one tree. Showing only the current frame's rows
   * is what made a marked moment feel lost after a frame step. */
  private renderRows(): void {
    const groups = this.savedFrames();
    const head = document.createElement("div");
    head.className = "image-annotator-list-head";
    const total = groups.reduce((sum, group) => sum + group.marks.length, 0);
    head.textContent = `Annotations (${total})`;
    const hint = document.createElement("div");
    hint.className = "image-annotator-list-hint";
    hint.textContent = "Pause the video, then drag on the picture to add a note. Each moment keeps its own notes.";
    const nodes = groups.map((group) => this.frameGroup(group));
    this.list.replaceChildren(head, ...(nodes.length ? nodes : [hint]));
  }

  /** One moment's header plus its rows; the header is the way back to it. */
  private frameGroup(group: FrameMarks): HTMLElement {
    const box = document.createElement("div");
    box.className = "video-annotator-frame-group";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "video-annotator-frame";
    header.classList.toggle("is-active", group.timeMs === this.key);
    header.title = "Go to this frame";
    header.textContent = `${formatTimecode(group.timeMs)} (${group.marks.length})`;
    header.addEventListener("click", () => { void this.seekMs(group.timeMs); });
    box.append(header, ...group.marks.map((mark, index) => this.row(group, mark, index)));
    return box;
  }

  private row(group: FrameMarks, mark: ImageMark, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "image-annotator-row";
    const badge = document.createElement("span");
    badge.className = "image-annotator-index";
    badge.textContent = String(index + 1);
    const label = document.createElement("span");
    label.className = "image-annotator-row-label";
    label.textContent = mark.kind === "region"
      ? `${mark.box.width}\u00d7${mark.box.height} at ${mark.box.x},${mark.box.y}`
      : `point ${mark.point.x},${mark.point.y}`;
    const note = document.createElement("textarea");
    note.className = "ui-dialog-input";
    note.rows = 1;
    note.placeholder = "What happens here?";
    note.value = mark.note;
    note.addEventListener("input", () => {
      mark.note = note.value;
      this.save();
    });
    // Only the current frame's marks are on the picture, so only they can light up.
    if (group.timeMs === this.key) {
      note.addEventListener("focus", () => this.highlight(index, true));
      note.addEventListener("blur", () => this.highlight(index, false));
      row.addEventListener("pointerenter", () => this.highlight(index, true));
      row.addEventListener("pointerleave", () => this.highlight(index, false));
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-annotator-remove";
    remove.setAttribute("aria-label", `Remove annotation ${index + 1}`);
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      group.marks.splice(index, 1);
      // A group this change emptied is not this frame's to commit.
      if (!group.marks.length) this.frames.delete(group.timeMs);
      this.save();
      this.renderMarks();
      this.renderRows();
      const inputs = this.list.querySelectorAll<HTMLTextAreaElement>(".image-annotator-row textarea");
      inputs[Math.min(index, inputs.length - 1)]?.focus();
    });
    row.append(badge, label, remove, note);
    return row;
  }

  /** Every still one Insert needs: the marked frames and the context that makes
   * them explicable, exported in time order. */
  private async insert(): Promise<void> {
    this.save();
    const marked = this.savedFrames();
    if (!marked.length) return;
    const marksByTime = new Map(marked.map((frame) => [frame.timeMs, frame.marks]));
    const plan = planContextFrames({ markTimesMs: marked.map((frame) => frame.timeMs), durationMs: this.durationMs() });
    const restore = this.video.currentTime * 1000;
    const wasPlaying = !this.video.paused;
    this.video.pause();
    this.setBusy(true);
    try {
      const frames: AnnotationFrame[] = [];
      for (const [index, frame] of plan.entries()) {
        this.progress.textContent = `Exporting frame ${index + 1}/${plan.length}`;
        await this.seekMs(frame.timeMs);
        const main = frame.role === "mark";
        const marks = main ? marksByTime.get(frame.timeMs) ?? [] : [];
        const imagePath = await this.options.storeFrame(
          this.snapshot(main ? MARK_EDGE : CONTEXT_EDGE, main ? MARK_QUALITY : CONTEXT_QUALITY, marks),
          "image/jpeg"
        );
        frames.push({ timeMs: frame.timeMs, role: frame.role, imagePath, ...(main ? { marks } : {}) });
      }
      this.options.onInsert(composeVideoAnnotationText(this.options.path, frames));
      // The cap is silent in the text block otherwise, and a trimmed context is
      // what an agent will miss first.
      this.progress.textContent = `${frames.length} frame images added.${plan.length >= MAX_PLANNED_FRAMES ? ` ${MAX_PLANNED_FRAMES} is the limit, so some context frames were left out.` : ""}`;
    } catch (failure) {
      this.showError(failure);
    } finally {
      await this.seekMs(restore);
      if (wasPlaying) void this.video.play();
      this.setBusy(false);
    }
  }

  private snapshot(longEdge: number, quality: number, marks: readonly ImageMark[] = []): string {
    const scale = Math.min(1, longEdge / Math.max(this.natural.width, this.natural.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(this.natural.width * scale));
    canvas.height = Math.max(1, Math.round(this.natural.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The video frame could not be captured in this editor.");
    context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    this.paintMarks(context, scale, marks);
    let url: string;
    try {
      url = canvas.toDataURL("image/jpeg", quality);
    } catch {
      // A `vscode-webview:` source taints the canvas; only the blob path can be read.
      throw new Error("This editor cannot capture the video's frames, so the notes cannot be sent with pictures.");
    }
    // The host stores raw base64, the same shape a pasted image arrives in.
    return url.slice(url.indexOf(",") + 1);
  }

  /** The notes' boxes burned into the still: coordinates alone leave the reader
   * guessing which part of the picture a frame annotation is about. */
  private paintMarks(context: CanvasRenderingContext2D, scale: number, marks: readonly ImageMark[]): void {
    if (!marks.length) return;
    const unit = Math.max(2, Math.round(this.natural.width * scale / 240));
    context.save();
    context.strokeStyle = MARK_COLOR;
    context.fillStyle = MARK_COLOR;
    context.lineWidth = unit;
    context.font = `600 ${unit * 6}px sans-serif`;
    for (const [index, mark] of marks.entries()) {
      const label = String(index + 1);
      if (mark.kind === "region") {
        const left = mark.box.x * scale;
        const top = mark.box.y * scale;
        context.strokeRect(left, top, mark.box.width * scale, mark.box.height * scale);
        // Above the box, or inside it when the box touches the top edge.
        context.textBaseline = "bottom";
        context.fillText(label, left, top > unit * 7 ? top - unit : top + unit * 7);
      } else {
        const x = mark.point.x * scale;
        const y = mark.point.y * scale;
        context.beginPath();
        context.arc(x, y, unit * 3, 0, Math.PI * 2);
        context.fill();
        // The number sits in the dot, the way it does on the paused page.
        context.fillStyle = "#1e1e1e";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, x, y);
        context.fillStyle = MARK_COLOR;
        context.textAlign = "start";
      }
    }
    context.restore();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.done.disabled = busy;
    this.play.disabled = busy;
    this.timeline.disabled = busy;
    if (busy) this.progress.textContent = "Exporting frames\u2026";
  }

  private showError(failure: unknown): void {
    this.error.textContent = failure instanceof Error ? failure.message : String(failure);
    this.error.hidden = false;
  }
}

import {
  boxFromPoints, clampZoom, composeAnnotationText, detectBlocks, displayToImage, fitScale, imageBoxToDisplay,
  keepAnchor, pickBlock, type DisplayRect, type ImageBox, type ImageMark, type ImagePoint
} from "./imageAnnotation.js";

export interface ImageAnnotatorOptions {
  /** Resolves the attachment's bytes as a `data:` URL. A `vscode-webview` URL
   * would taint the canvas and make `getImageData` throw. */
  loadImage(): Promise<string>;
  onInsert(text: string): void;
}

/** Long edge of the canvas the block detector reads. Downsampling is what keeps
 * opening the overlay instant on a full-screen screenshot. */
const SCAN_MAX_EDGE = 720;
/** Below this pointer travel a press is a click, not a hand-drawn box. */
const DRAG_THRESHOLD = 4;
/** A point mark is a dot you can click, not a pixel marker. */
const POINT_SIZE = 18;
/** Drop for the number chip outside the box: it needs this much room above. */
const BADGE_HEIGHT = 22;
const ZOOM_STEP = 1.25;

const place = (
  element: HTMLElement, left: number, top: number, width: number, height: number
): void => {
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${Math.max(width, 0)}px`;
  element.style.height = `${Math.max(height, 0)}px`;
};

/** Annotation page for one attachment: hover selects a flat UI block, a drag
 * draws an arbitrary box, a tap on flat space drops a point. */
export class ImageAnnotator {
  readonly element: HTMLElement;
  private readonly image = document.createElement("img");
  private readonly stage = document.createElement("div");
  private readonly layers = document.createElement("div");
  private readonly hover = document.createElement("div");
  private readonly preview = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly error = document.createElement("div");
  private readonly done = document.createElement("button");
  private readonly zoomLabel = document.createElement("span");
  private readonly sizeLabel = document.createElement("span");
  private readonly toggle = document.createElement("button");
  private path = "";
  /** shortcut: memory only, reloading the tab starts empty. */
  private marks: ImageMark[] = [];
  private blocks: ImageBox[] = [];
  private natural = { width: 0, height: 0 };
  /** Display pixels per image pixel. `fit` keeps it tied to the window size. */
  private zoom = 1;
  private fit = true;
  /** Marks hidden: the untouched picture, and no way to draw an invisible one. */
  private plain = false;
  private drag: { from: ImagePoint; client: ImagePoint; pointerId: number } | undefined;

  constructor(private readonly options: ImageAnnotatorOptions) {
    this.element = document.createElement("div");
    this.element.className = "image-annotator";

    this.image.className = "image-annotator-image";
    this.image.alt = "";
    this.stage.className = "image-annotator-stage";
    this.hover.className = "image-annotator-hover";
    this.preview.className = "image-annotator-box image-annotator-drawing";
    this.hover.hidden = true;
    this.preview.hidden = true;
    this.layers.className = "image-annotator-layers";
    this.layers.append(this.hover, this.preview);
    this.stage.append(this.image, this.layers);

    this.list.className = "image-annotator-list";
    this.list.hidden = true;
    this.error.className = "image-annotator-error";
    this.error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "ui-dialog-actions";
    this.done.type = "button";
    this.done.textContent = "Insert annotations";
    this.done.disabled = true;
    this.done.addEventListener("click", () => this.insert());
    actions.append(this.done);
    this.zoomLabel.className = "image-annotator-zoom";
    this.sizeLabel.className = "image-annotator-size";
    this.toggle.type = "button";
    this.toggle.className = "image-annotator-toggle";
    this.toggle.title = "Show or hide the marks on the picture";
    this.toggle.addEventListener("click", () => this.setPlain(!this.plain));
    this.setPlain(false);
    this.element.append(this.stage, this.tools(), this.error, this.list, actions);

    this.stage.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.stage.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.stage.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.stage.addEventListener("pointerleave", () => { if (!this.drag) this.hover.hidden = true; });
    this.stage.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    // A resized sidebar moves the picture under the marks, so re-place them.
    new ResizeObserver(() => {
      if (this.fit && this.natural.width) this.setZoom(this.fitScaleNow(), true);
      this.renderMarks();
    }).observe(this.stage);
  }

  /** Zoom, fit and 1:1 under the picture: the controls a screenshot needs before
   * anyone can point at a 4px detail in it. */
  private tools(): HTMLElement {
    const tools = document.createElement("div");
    tools.className = "image-annotator-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", "Zoom");
    const button = (label: string, title: string, run: () => void): HTMLButtonElement => {
      const node = document.createElement("button");
      node.type = "button";
      node.textContent = label;
      node.title = title;
      node.setAttribute("aria-label", title);
      node.addEventListener("click", run);
      return node;
    };
    tools.append(
      button("\u2212", "Zoom out", () => this.zoomBy(1 / ZOOM_STEP)),
      this.zoomLabel,
      button("+", "Zoom in", () => this.zoomBy(ZOOM_STEP)),
      button("Fit", "Fit the picture to the window", () => this.setZoom(this.fitScaleNow(), true)),
      button("1:1", "Original size", () => this.setZoom(1, false)),
      this.sizeLabel,
      this.toggle
    );
    return tools;
  }

  /** Hiding the marks is how you compare against the raw screenshot; drawing stops
   * with them, so a click cannot leave a mark nobody can see. */
  private setPlain(plain: boolean): void {
    this.plain = plain;
    this.element.classList.toggle("image-annotator-plain", plain);
    this.toggle.textContent = plain ? "Show annotations" : "Hide annotations";
    this.toggle.setAttribute("aria-pressed", String(plain));
    if (plain) this.hover.hidden = true;
  }

  private fitScaleNow(): number {
    return fitScale(this.natural, { width: this.stage.clientWidth, height: this.stage.clientHeight });
  }

  /** Setting the width is the whole zoom: the stage scrolls, and one scroll
   * correction keeps `anchor` on the same pixel. Passing it makes that pixel
   * the pointer, or the middle of the picture when a button asked. */
  private setZoom(scale: number, fit: boolean, anchor?: ImagePoint): void {
    if (!this.natural.width) return;
    const before = this.image.getBoundingClientRect();
    this.fit = fit;
    this.zoom = clampZoom(scale);
    // A whole-pixel width, so a fit never overflows by half a pixel into a scrollbar
    // that shrinks the stage and asks for another fit.
    this.image.style.width = `${Math.floor(this.natural.width * this.zoom)}px`;
    if (anchor) {
      const after = this.image.getBoundingClientRect();
      const scroll = keepAnchor(before, after, anchor, { left: this.stage.scrollLeft, top: this.stage.scrollTop });
      this.stage.scrollLeft = scroll.left;
      this.stage.scrollTop = scroll.top;
    }
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.renderMarks();
  }

  private zoomBy(factor: number): void {
    const stage = this.stage.getBoundingClientRect();
    this.setZoom(this.zoom * factor, false, { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 });
  }

  /** Ctrl/Cmd + wheel zooms around the pointer; a plain wheel stays the stage's
   * own scrolling, so a trackpad pans the way it always does. */
  private wheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey) || !this.natural.width) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    const scale = clampZoom(this.zoom * Math.exp(-delta * 0.0015));
    if (scale === this.zoom) return;
    this.setZoom(scale, false, { x: event.clientX, y: event.clientY });
  }

  /** One image per editor tab: the page shows the picture and annotates at once. */
  open(relativePath: string, name: string): void {
    this.path = relativePath;
    this.image.title = name;
    if (!this.element.isConnected) document.body.append(this.element);
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const url = await this.options.loadImage();
      await new Promise<void>((resolve, reject) => {
        this.image.onload = () => resolve();
        this.image.onerror = () => reject(new Error("The attachment image could not be decoded."));
        this.image.src = url;
      });
      this.natural = { width: this.image.naturalWidth, height: this.image.naturalHeight };
      this.sizeLabel.textContent = `${this.natural.width} \u00d7 ${this.natural.height}`;
      this.blocks = this.scanBlocks();
      this.done.disabled = false;
      this.setZoom(this.fitScaleNow(), true);
    } catch (error) {
      this.error.textContent = error instanceof Error ? error.message : String(error);
      this.error.hidden = false;
    }
  }

  private scanBlocks(): ImageBox[] {
    const { width, height } = this.natural;
    const scale = Math.min(1, SCAN_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(this.image, 0, 0, canvas.width, canvas.height);
    let pixels: ImageData;
    try {
      pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
      // A tainted canvas only means "no hover select"; drawing boxes still works.
      return [];
    }
    const scaleX = width / canvas.width;
    const scaleY = height / canvas.height;
    return detectBlocks(pixels).map((block) => ({
      x: Math.floor(block.x * scaleX),
      y: Math.floor(block.y * scaleY),
      width: Math.ceil(block.width * scaleX),
      height: Math.ceil(block.height * scaleY)
    }));
  }

  /** The stage's own pixel space, so overlay styles can use these numbers directly.
   * The layers scroll with the picture, so these are content coordinates. */
  private displayRect(): DisplayRect {
    const image = this.image.getBoundingClientRect();
    const stage = this.stage.getBoundingClientRect();
    return {
      left: image.left - stage.left + this.stage.scrollLeft,
      top: image.top - stage.top + this.stage.scrollTop,
      width: image.width,
      height: image.height
    };
  }

  private imagePoint(client: ImagePoint): ImagePoint {
    return displayToImage(this.image.getBoundingClientRect(), this.natural, client);
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.natural.width || this.plain) return;
    const mark = event.target instanceof Element ? event.target.closest<HTMLElement>(".image-annotator-mark") : null;
    if (mark) {
      // A press on a mark edits its note, so a box is not drawn on top of it.
      event.preventDefault();
      this.focusNote(Number(mark.dataset.index));
      return;
    }
    event.preventDefault();
    this.stage.setPointerCapture(event.pointerId);
    this.drag = { from: this.imagePoint(event), client: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId };
    this.hover.hidden = true;
  }

  private focusNote(index: number): void {
    if (!Number.isInteger(index)) return;
    this.list.querySelectorAll<HTMLInputElement>(".image-annotator-row input")[index]?.focus();
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.natural.width || this.plain) return;
    const display = this.displayRect();
    if (this.drag) {
      const rect = imageBoxToDisplay(display, this.natural, boxFromPoints(this.drag.from, this.imagePoint(event)));
      place(this.preview, rect.left, rect.top, rect.width, rect.height);
      this.preview.hidden = false;
      return;
    }
    if (event.target instanceof Element && event.target.closest(".image-annotator-mark")) {
      this.hover.hidden = true;
      return;
    }
    const block = pickBlock(this.blocks, this.imagePoint(event));
    if (!block) { this.hover.hidden = true; return; }
    const box = imageBoxToDisplay(display, this.natural, block);
    place(this.hover, box.left, box.top, box.width, box.height);
    this.hover.hidden = false;
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag || !this.natural.width) return;
    const drag = this.drag;
    this.drag = undefined;
    this.preview.hidden = true;
    if (this.stage.hasPointerCapture(drag.pointerId)) this.stage.releasePointerCapture(drag.pointerId);
    const end = this.imagePoint(event);
    if (Math.hypot(event.clientX - drag.client.x, event.clientY - drag.client.y) < DRAG_THRESHOLD) {
      // A click: take the block under the cursor, or drop a point on flat space.
      const block = pickBlock(this.blocks, end);
      this.marks.push(block
        ? { kind: "region", box: block, note: "" }
        : { kind: "point", point: end, note: "" });
    } else {
      const box = boxFromPoints(drag.from, end);
      if (!box.width || !box.height) return;
      this.marks.push({ kind: "region", box, note: "" });
    }
    this.renderMarks();
    this.renderRows();
    // Focus the note of the mark that was just added, not the first one.
    this.list.lastElementChild?.querySelector("input")?.focus();
  }
  /** Row and mark share a number; hovering or focusing a row outlines its mark so
   * the two are readable as one item. */
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
          // The number normally sits above the box; near the top edge it moves inside.
          node.classList.toggle("image-annotator-badge-inside", rect.top < BADGE_HEIGHT);
        } else {
          // A point has no box of its own: center a fixed dot on the pixel.
          const rect = imageBoxToDisplay(display, this.natural, { ...mark.point, width: 0, height: 0 });
          place(node, rect.left - POINT_SIZE / 2, rect.top - POINT_SIZE / 2, POINT_SIZE, POINT_SIZE);
        }
      }
      return node;
    });
    this.layers.replaceChildren(this.hover, this.preview, ...nodes);
  }

  private renderRows(): void {
    const head = document.createElement("div");
    head.className = "image-annotator-list-head";
    head.textContent = `Annotations (${this.marks.length})`;
    this.list.replaceChildren(head, ...this.marks.map((mark, index) => {
      const row = document.createElement("div");
      row.className = "image-annotator-row";
      // The same chip the picture draws, so a row and its box read as one item.
      const badge = document.createElement("span");
      badge.className = "image-annotator-index";
      badge.textContent = String(index + 1);
      const label = document.createElement("span");
      label.className = "image-annotator-row-label";
      label.textContent = mark.kind === "region"
        ? `${mark.box.width}\u00d7${mark.box.height} at ${mark.box.x},${mark.box.y}`
        : `point ${mark.point.x},${mark.point.y}`;
      const note = document.createElement("input");
      note.className = "ui-dialog-input";
      note.type = "text";
      note.placeholder = "What changes here?";
      note.value = mark.note;
      note.addEventListener("input", () => { mark.note = note.value; });
      note.addEventListener("focus", () => this.highlight(index, true));
      note.addEventListener("blur", () => this.highlight(index, false));
      row.addEventListener("pointerenter", () => this.highlight(index, true));
      row.addEventListener("pointerleave", () => this.highlight(index, false));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "image-annotator-remove";
      remove.setAttribute("aria-label", `Remove annotation ${index + 1}`);
      remove.textContent = "\u00d7";
      remove.addEventListener("click", () => {
        this.marks.splice(index, 1);
        this.renderMarks();
        this.renderRows();
        // Deleting must not drop the keyboard on the floor.
        this.focusNote(Math.min(index, this.marks.length - 1));
      });
      row.append(badge, label, remove, note);
      return row;
    }));
    this.list.hidden = this.marks.length === 0;
  }

  private insert(): void {
    if (this.marks.length) this.options.onInsert(composeAnnotationText(this.path, this.marks));
  }
}

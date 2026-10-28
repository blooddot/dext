import {
  boxFromPoints, composeAnnotationText, detectBlocks, displayToImage, imageBoxToDisplay, pickBlock,
  type DisplayRect, type ImageBox, type ImageMark, type ImagePoint
} from "./imageAnnotation.js";

export interface ImageAnnotatorOptions {
  /** Resolves the attachment's bytes as a `data:` URL. A `vscode-webview` URL
   * would taint the canvas and make `getImageData` throw. */
  loadImage(relativePath: string): Promise<string>;
  /** `previous` is this attachment's earlier block, so re-annotating updates it
   * instead of stacking a second copy in the Input. */
  onInsert(text: string, previous?: string): void;
}

/** Long edge of the canvas the block detector reads. Downsampling is what keeps
 * opening the overlay instant on a full-screen screenshot. */
const SCAN_MAX_EDGE = 720;
/** Below this pointer travel a press is a click, not a hand-drawn box. */
const DRAG_THRESHOLD = 4;

const place = (
  element: HTMLElement, left: number, top: number, width: number, height: number
): void => {
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${Math.max(width, 0)}px`;
  element.style.height = `${Math.max(height, 0)}px`;
};

/** Annotation overlay for one attachment: hover selects a flat UI block, a drag
 * draws an arbitrary box, a tap on flat space drops a point. */
export class ImageAnnotator {
  readonly element: HTMLDialogElement;
  private readonly image = document.createElement("img");
  private readonly stage = document.createElement("div");
  private readonly layers = document.createElement("div");
  private readonly hover = document.createElement("div");
  private readonly preview = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly error = document.createElement("div");
  private readonly done = document.createElement("button");
  private path = "";
  private marks: ImageMark[] = [];
  /** Notes survive closing the overlay, so reopening an attachment is an edit.
   * shortcut: memory only, a Webview reload starts empty. */
  private readonly saved = new Map<string, ImageMark[]>();
  /** What was last inserted per attachment, for replacing rather than duplicating. */
  private readonly inserted = new Map<string, string>();
  private blocks: ImageBox[] = [];
  private natural = { width: 0, height: 0 };
  private loadToken = 0;
  private drag: { from: ImagePoint; client: ImagePoint; pointerId: number } | undefined;

  constructor(private readonly options: ImageAnnotatorOptions) {
    this.element = document.createElement("dialog");
    this.element.className = "ui-dialog image-annotator";
    const surface = document.createElement("div");
    surface.className = "ui-dialog-surface";
    const head = document.createElement("div");
    head.className = "image-annotator-head";
    const title = document.createElement("span");
    title.textContent = "Annotate image";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "image-annotator-close";
    close.setAttribute("aria-label", "Close annotation");
    close.textContent = "\u00d7";
    close.addEventListener("click", () => this.close());
    head.append(title, close);

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
    this.error.className = "image-annotator-error";
    this.error.hidden = true;

    const body = document.createElement("div");
    body.className = "ui-dialog-body";
    body.append(this.stage, this.error, this.list);

    const actions = document.createElement("div");
    actions.className = "ui-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    this.done.type = "button";
    this.done.textContent = "Insert annotations";
    this.done.addEventListener("click", () => this.insert());
    actions.append(cancel, this.done);
    surface.append(head, body, actions);
    this.element.append(surface);

    this.element.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.stage.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.stage.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.stage.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.stage.addEventListener("pointerleave", () => { if (!this.drag) this.hover.hidden = true; });
    // A resized sidebar moves the picture under the marks, so re-place them.
    new ResizeObserver(() => this.renderMarks()).observe(this.stage);
  }

  open(relativePath: string, name: string): void {
    this.path = relativePath;
    this.marks = this.saved.get(relativePath) ?? [];
    this.blocks = [];
    this.drag = undefined;
    this.natural = { width: 0, height: 0 };
    this.image.title = name;
    this.error.hidden = true;
    this.done.disabled = true;
    this.renderMarks();
    this.renderRows();
    if (!this.element.isConnected) document.body.append(this.element);
    if (!this.element.open) this.element.showModal();
    void this.load(relativePath);
  }

  close(): void {
    this.loadToken++;
    this.saved.set(this.path, this.marks);
    this.drag = undefined;
    this.hover.hidden = true;
    this.preview.hidden = true;
    if (this.element.open) this.element.close();
  }

  private async load(relativePath: string): Promise<void> {
    const token = ++this.loadToken;
    try {
      const url = await this.options.loadImage(relativePath);
      await new Promise<void>((resolve, reject) => {
        this.image.onload = () => resolve();
        this.image.onerror = () => reject(new Error("The attachment image could not be decoded."));
        this.image.src = url;
      });
      if (token !== this.loadToken) return;
      this.natural = { width: this.image.naturalWidth, height: this.image.naturalHeight };
      this.blocks = this.scanBlocks();
      this.done.disabled = false;
    } catch (error) {
      if (token !== this.loadToken) return;
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

  /** The stage's own pixel space, so overlay styles can use these numbers directly. */
  private displayRect(): DisplayRect {
    const image = this.image.getBoundingClientRect();
    const stage = this.stage.getBoundingClientRect();
    return {
      left: image.left - stage.left,
      top: image.top - stage.top,
      width: image.width,
      height: image.height
    };
  }

  private imagePoint(client: ImagePoint): ImagePoint {
    return displayToImage(this.image.getBoundingClientRect(), this.natural, client);
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.natural.width) return;
    event.preventDefault();
    this.stage.setPointerCapture(event.pointerId);
    this.drag = { from: this.imagePoint(event), client: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId };
    this.hover.hidden = true;
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.natural.width) return;
    const display = this.displayRect();
    if (this.drag) {
      const rect = imageBoxToDisplay(display, this.natural, boxFromPoints(this.drag.from, this.imagePoint(event)));
      place(this.preview, rect.left, rect.top, rect.width, rect.height);
      this.preview.hidden = false;
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
      const badge = document.createElement("span");
      badge.className = "image-annotator-index";
      badge.textContent = String(index + 1);
      node.append(badge);
      if (display) {
        if (mark.kind === "region") {
          const rect = imageBoxToDisplay(display, this.natural, mark.box);
          place(node, rect.left, rect.top, rect.width, rect.height);
        } else {
          // A point has no box of its own: center a fixed dot on the pixel.
          const rect = imageBoxToDisplay(display, this.natural, { ...mark.point, width: 0, height: 0 });
          place(node, rect.left - 7, rect.top - 7, 14, 14);
        }
      }
      return node;
    });
    this.layers.replaceChildren(this.hover, this.preview, ...nodes);
  }

  private renderRows(): void {
    this.list.replaceChildren(...this.marks.map((mark, index) => {
      const row = document.createElement("div");
      row.className = "image-annotator-row";
      const label = document.createElement("span");
      label.className = "image-annotator-row-label";
      label.textContent = mark.kind === "region"
        ? `${index + 1}. ${mark.box.width}\u00d7${mark.box.height} at ${mark.box.x},${mark.box.y}`
        : `${index + 1}. point ${mark.point.x},${mark.point.y}`;
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
      });
      row.append(label, note, remove);
      return row;
    }));
    this.list.hidden = this.marks.length === 0;
  }

  private insert(): void {
    if (!this.marks.length) { this.close(); return; }
    const text = composeAnnotationText(this.path, this.marks);
    const previous = this.inserted.get(this.path);
    this.inserted.set(this.path, text);
    // Close first: a modal dialog keeps the page inert, so the editor cannot take
    // focus (and show the caret) until the overlay is gone.
    this.close();
    this.options.onInsert(text, previous);
  }
}

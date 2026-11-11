import type { DraftAttachment } from "../features/conversations/browser/composerController.js";

export interface ImageAttachmentHost {
  bar: HTMLElement;
  post: (message:
    | { type: "openFileReference"; reference: string }
    | { type: "deleteImageAttachment"; relativePath: string }) => void;
  removeReference: (relativePath: string) => void;
  /** The composer draft keeps the chips, so every change saves it. */
  onChanged: () => void;
}

/** A video attachment's chip shows its name: painting a still here would mean
 * decoding the file twice. */
const VIDEO_PATH = /\.(?:mp4|m4v|mov|webm)$/i;

/** Pasted-image chips above the Input. A chip stands for a file the turn already
 * refers to, so removing one never deletes the file. */
export class ImageAttachments {
  private readonly chips = new Map<string, HTMLElement>();
  private readonly files = new Map<string, DraftAttachment>();

  constructor(private readonly host: ImageAttachmentHost) {}

  add(relativePath: string, webviewUri: string, name: string): void {
    if (this.chips.has(relativePath)) return;
    // A video has no still to show without decoding it, so its chip is its name.
    const video = VIDEO_PATH.test(relativePath);
    const chip = document.createElement("div");
    chip.className = video ? "image-attachment image-attachment-video" : "image-attachment";
    const preview: HTMLElement = document.createElement(video ? "div" : "img");
    if (video) {
      preview.className = "image-attachment-name";
      preview.textContent = name;
    } else {
      (preview as HTMLImageElement).src = webviewUri;
      (preview as HTMLImageElement).alt = name;
    }
    // A dropped video is copied in, not referenced, so the chip says where it lives.
    preview.title = video ? `Open ${name} (copied into Dext's attachments folder)` : `Open ${name}`;
    preview.setAttribute("role", "button");
    preview.tabIndex = 0;
    // The chip opens the same editor tab as an @ reference to this attachment.
    const openPreview = (): void => this.host.post({ type: "openFileReference", reference: relativePath });
    preview.addEventListener("click", openPreview);
    preview.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openPreview();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-attachment-remove";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      chip.remove();
      this.chips.delete(relativePath);
      this.host.bar.classList.toggle("hidden", this.chips.size === 0);
      this.files.delete(relativePath);
      this.host.removeReference(relativePath);
      this.host.post({ type: "deleteImageAttachment", relativePath });
    });
    chip.append(preview, remove);
    this.host.bar.append(chip);
    this.host.bar.classList.remove("hidden");
    this.chips.set(relativePath, chip);
    this.files.set(relativePath, { relativePath, webviewUri, name });
    this.host.onChanged();
  }

  clear(): void {
    for (const chip of this.chips.values()) chip.remove();
    this.chips.clear();
    this.files.clear();
    this.host.bar.classList.add("hidden");
  }

  all(): DraftAttachment[] {
    return [...this.files.values()];
  }
}

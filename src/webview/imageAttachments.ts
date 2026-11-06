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

/** Pasted-image chips above the Input. A chip stands for a file the turn already
 * refers to, so removing one never deletes the file. */
export class ImageAttachments {
  private readonly chips = new Map<string, HTMLElement>();
  private readonly files = new Map<string, DraftAttachment>();

  constructor(private readonly host: ImageAttachmentHost) {}

  add(relativePath: string, webviewUri: string, name: string): void {
    if (this.chips.has(relativePath)) return;
    const chip = document.createElement("div");
    chip.className = "image-attachment";
    const image = document.createElement("img");
    image.src = webviewUri;
    image.alt = name;
    image.title = `Open ${name}`;
    image.setAttribute("role", "button");
    image.tabIndex = 0;
    // The chip opens the same editor tab as an @ reference to this attachment.
    const openPreview = (): void => this.host.post({ type: "openFileReference", reference: relativePath });
    image.addEventListener("click", openPreview);
    image.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openPreview();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-attachment-remove";
    remove.setAttribute("aria-label", "Remove image");
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      chip.remove();
      this.chips.delete(relativePath);
      this.host.bar.classList.toggle("hidden", this.chips.size === 0);
      this.files.delete(relativePath);
      this.host.removeReference(relativePath);
      this.host.post({ type: "deleteImageAttachment", relativePath });
    });
    chip.append(image, remove);
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

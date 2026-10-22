export interface FileReferenceChipDescriptor {
  label: string;
  title: string;
  openLabel: string;
  removeLabel: string;
}

export interface FileReferenceChipOptions extends FileReferenceChipDescriptor {
  document: Document;
  modifierClass?: string;
  icon?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  suppressPointerDown?: boolean;
}

export function fileReferenceChipDescriptor(label: string, title: string): FileReferenceChipDescriptor {
  return {
    label,
    title,
    openLabel: `Open ${label}`,
    removeLabel: `Remove ${label}`
  };
}

export function createFileReferenceChip(options: FileReferenceChipOptions): HTMLElement {
  const chip = options.document.createElement("span");
  chip.className = `attachment-chip${options.modifierClass ? ` ${options.modifierClass}` : ""}`;
  chip.title = options.title;

  const open = options.document.createElement("button");
  open.type = "button";
  open.className = "attachment-open";
  open.title = options.openLabel;
  open.setAttribute("aria-label", options.openLabel);
  const icon = options.document.createElement("i");
  icon.className = `codicon codicon-${options.icon ?? "file"}`;
  const label = options.document.createElement("span");
  label.className = "attachment-label";
  label.textContent = options.label;
  open.append(icon, label);

  const remove = options.document.createElement("button");
  remove.type = "button";
  remove.className = "attachment-remove";
  remove.title = options.removeLabel;
  remove.setAttribute("aria-label", options.removeLabel);
  const close = options.document.createElement("i");
  close.className = "codicon codicon-close";
  remove.append(close);
  chip.append(open);
  if (options.onRemove) chip.append(remove);

  if (options.suppressPointerDown) {
    for (const eventName of ["pointerdown", "mousedown"] as const) {
      chip.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
  }
  if (options.onOpen) {
    open.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onOpen?.();
    });
  }
  if (options.onRemove) {
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onRemove?.();
    });
  }
  return chip;
}

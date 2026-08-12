import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import { compactFileReferenceLabel } from "../core/fileReference.js";
import {
  createFileReferenceChip,
  fileReferenceChipDescriptor
} from "./fileReferenceChip.js";

export interface FileReferenceOccurrence {
  start: number;
  end: number;
  expression: string;
  payload: string;
}

export interface FileReferenceDecorationOptions {
  onOpen(reference: string): void;
}

function quotedStringEnd(source: string, start: number): number | undefined {
  let escaped = false;
  for (let offset = start; offset < source.length; offset += 1) {
    const character = source[offset];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return offset;
  }
  return undefined;
}

export function fileReferenceOccurrences(source: string): FileReferenceOccurrence[] {
  const occurrences: FileReferenceOccurrence[] = [];
  const prefix = /@file\s*\(\s*"/g;
  for (const match of source.matchAll(prefix)) {
    const start = match.index ?? 0;
    const payloadStart = start + match[0].length;
    const quoteEnd = quotedStringEnd(source, payloadStart);
    if (quoteEnd === undefined) continue;
    const close = /^\s*\)/.exec(source.slice(quoteEnd + 1));
    if (!close) continue;
    let payload: string;
    try {
      payload = JSON.parse(`"${source.slice(payloadStart, quoteEnd)}"`) as string;
    } catch {
      continue;
    }
    if (!payload) continue;
    const end = quoteEnd + 1 + close[0].length;
    occurrences.push({ start, end, expression: source.slice(start, end), payload });
  }
  return occurrences;
}

class FileReferenceWidget extends WidgetType {
  constructor(
    private readonly occurrence: FileReferenceOccurrence,
    private readonly onOpen: (reference: string) => void
  ) {
    super();
  }

  override eq(other: FileReferenceWidget): boolean {
    return this.occurrence.start === other.occurrence.start
      && this.occurrence.end === other.occurrence.end
      && this.occurrence.payload === other.occurrence.payload;
  }

  override toDOM(view: EditorView): HTMLElement {
    const descriptor = fileReferenceChipDescriptor(
      compactFileReferenceLabel(this.occurrence.payload),
      this.occurrence.payload
    );
    return createFileReferenceChip({
      document: view.dom.ownerDocument,
      ...descriptor,
      modifierClass: "code-file-reference",
      suppressPointerDown: true,
      onOpen: () => this.onOpen(this.occurrence.payload),
      onRemove: () => {
        view.dispatch({
          changes: { from: this.occurrence.start, to: this.occurrence.end },
          selection: { anchor: this.occurrence.start },
          scrollIntoView: true,
          userEvent: "delete"
        });
        view.focus();
      }
    });
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function referenceDecorations(
  view: EditorView,
  onOpen: (reference: string) => void
): DecorationSet {
  return Decoration.set(fileReferenceOccurrences(view.state.doc.toString()).map((occurrence) => (
    Decoration.replace({
      widget: new FileReferenceWidget(occurrence, onOpen),
      inclusive: false
    }).range(occurrence.start, occurrence.end)
  )), true);
}

export function fileReferenceDecorations(options: FileReferenceDecorationOptions): Extension {
  const onOpen = (reference: string): void => options.onOpen(reference);
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = referenceDecorations(view, onOpen);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = referenceDecorations(update.view, onOpen);
    }
  }, {
    decorations: (value) => value.decorations
  });

  return [
    plugin,
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
  ];
}

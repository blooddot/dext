import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import {
  compactFileReferenceLabel,
  fileReferenceOccurrences,
  type FileReferenceOccurrence
} from "../core/fileReference.js";
import {
  createFileReferenceChip,
  fileReferenceChipDescriptor
} from "./fileReferenceChip.js";

export { fileReferenceOccurrences } from "../core/fileReference.js";

export interface FileReferenceDecorationOptions {
  onOpen(reference: string): void;
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

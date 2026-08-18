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
  inputReferenceProjections,
  type InputReferenceProjection
} from "../core/fileReference.js";
import {
  createFileReferenceChip,
  fileReferenceChipDescriptor
} from "./fileReferenceChip.js";

export {
  fileReferenceOccurrences,
  inputReferenceProjections
} from "../core/fileReference.js";

export interface FileReferenceDecorationOptions {
  onOpen(reference: string): void;
}

class FileReferenceWidget extends WidgetType {
  constructor(
    private readonly projection: InputReferenceProjection,
    private readonly onOpen: (reference: string) => void
  ) {
    super();
  }

  override eq(other: FileReferenceWidget): boolean {
    return this.projection.interpolationStart === other.projection.interpolationStart
      && this.projection.interpolationEnd === other.projection.interpolationEnd
      && this.projection.reference.payload === other.projection.reference.payload;
  }

  override toDOM(view: EditorView): HTMLElement {
    const descriptor = fileReferenceChipDescriptor(
      compactFileReferenceLabel(this.projection.reference.payload),
      this.projection.reference.payload
    );
    return createFileReferenceChip({
      document: view.dom.ownerDocument,
      ...descriptor,
      modifierClass: "code-file-reference",
      suppressPointerDown: true,
      onOpen: () => this.onOpen(this.projection.reference.payload),
      onRemove: () => {
        view.dispatch({
          changes: {
            from: this.projection.interpolationStart,
            to: this.projection.interpolationEnd
          },
          selection: { anchor: this.projection.interpolationStart },
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

export function inputReferenceProjectionDecorations(
  source: string,
  onOpen: (reference: string) => void
): DecorationSet {
  const projections = inputReferenceProjections(source);
  return Decoration.set([
    ...projections.map((projection) => (
      Decoration.replace({
        widget: new FileReferenceWidget(projection, onOpen),
        inclusive: false
      }).range(projection.interpolationStart, projection.interpolationEnd)
    ))
  ], true);
}

export function fileReferenceDecorations(options: FileReferenceDecorationOptions): Extension {
  const onOpen = (reference: string): void => options.onOpen(reference);
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = inputReferenceProjectionDecorations(view.state.doc.toString(), onOpen);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.decorations = inputReferenceProjectionDecorations(update.view.state.doc.toString(), onOpen);
      }
    }
  }, {
    decorations: (value) => value.decorations
  });

  return [
    plugin,
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)
  ];
}

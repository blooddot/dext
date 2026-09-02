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
  type ContextReferenceOccurrence,
  type InputReferenceProjection
} from "../core/fileReference.js";
import {
  createFileReferenceChip,
  fileReferenceChipDescriptor
} from "./fileReferenceChip.js";

export {
  inputReferenceProjections
} from "../core/fileReference.js";

export interface FileReferenceDecorationOptions {
  onOpen(reference: ContextReferenceOccurrence): void;
}

interface DecoratedReference {
  projection: InputReferenceProjection;
  from: number;
  to: number;
}

export interface FileReferenceRemovalEdit {
  from: number;
  to: number;
  insert: string;
}

function whitespaceBefore(source: string, offset: number): number {
  while (offset > 0 && /[ \t]/.test(source[offset - 1] ?? "")) offset -= 1;
  return offset;
}

function whitespaceAfter(source: string, offset: number, maximum = Number.POSITIVE_INFINITY): number {
  let count = 0;
  while (offset < source.length && count < maximum && /[ \t]/.test(source[offset] ?? "")) {
    offset += 1;
    count += 1;
  }
  return offset;
}

function hasAdjacentText(source: string, offset: number, direction: -1 | 1): boolean {
  const character = source[offset + (direction < 0 ? -1 : 0)] ?? "";
  // Quotes and Dext syntax delimiters frame an input value but are not user
  // text; retaining a space beside them after a chip removal is just noise.
  return Boolean(character) && !/[ \t\r\n"'`()\x5B\x5D{},=]/.test(character);
}

/** Source separators remain visible around a reference just as they do in the
 * rendered turn output. The chip itself stays atomic; the separators keep the
 * next typed character outside the path token. */
function decoratedReferences(source: string): DecoratedReference[] {
  return inputReferenceProjections(source).map((projection) => ({
    projection,
    from: projection.interpolationStart,
    to: projection.interpolationEnd
  }));
}

/** Removes a chip and its artificial separators. Text on both sides keeps one
 * ordinary space, so deleting an attachment cannot join the following words. */
export function fileReferenceRemovalEdit(
  source: string,
  projection: InputReferenceProjection
): FileReferenceRemovalEdit {
  const from = whitespaceBefore(source, projection.interpolationStart);
  const to = whitespaceAfter(source, projection.interpolationEnd);
  const hasTextBefore = hasAdjacentText(source, from, -1);
  const hasTextAfter = hasAdjacentText(source, to, 1);
  return { from, to, insert: hasTextBefore && hasTextAfter ? " " : "" };
}

class FileReferenceWidget extends WidgetType {
  constructor(
    private readonly projection: InputReferenceProjection,
    private readonly decorationStart: number,
    private readonly decorationEnd: number,
    private readonly onOpen: (reference: ContextReferenceOccurrence) => void
  ) {
    super();
  }

  override eq(other: FileReferenceWidget): boolean {
    return this.projection.interpolationStart === other.projection.interpolationStart
      && this.projection.interpolationEnd === other.projection.interpolationEnd
      && this.decorationStart === other.decorationStart
      && this.decorationEnd === other.decorationEnd
      && this.projection.reference.kind === other.projection.reference.kind
      && this.projection.reference.payload === other.projection.reference.payload;
  }

  override toDOM(view: EditorView): HTMLElement {
    const source = view.state.doc.toString();
    const before = source[this.projection.interpolationStart - 1] ?? "";
    const after = source[this.projection.interpolationEnd] ?? "";
    const descriptor = fileReferenceChipDescriptor(
      compactFileReferenceLabel(this.projection.reference.payload),
      this.projection.reference.payload
    );
    return createFileReferenceChip({
      document: view.dom.ownerDocument,
      ...descriptor,
      modifierClass: [
        "code-file-reference",
        before && !/[\s]/.test(before)
          ? "reference-adjacent-before" : "",
        after && !/[\s]/.test(after)
          ? "reference-adjacent-after" : ""
      ].filter(Boolean).join(" "),
      suppressPointerDown: true,
      onOpen: () => this.onOpen(this.projection.reference),
      onRemove: () => {
        const removal = fileReferenceRemovalEdit(view.state.doc.toString(), this.projection);
        view.dispatch({
          changes: {
            from: removal.from,
            to: removal.to,
            insert: removal.insert
          },
          selection: { anchor: removal.from + removal.insert.length },
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
  onOpen: (reference: ContextReferenceOccurrence) => void
): DecorationSet {
  const projections = decoratedReferences(source);
  return Decoration.set([
    ...projections.map(({ projection, from, to }) => (
      Decoration.replace({
        widget: new FileReferenceWidget(projection, from, to, onOpen),
        inclusive: false
      }).range(from, to)
    ))
  ], true);
}

export function fileReferenceDecorations(options: FileReferenceDecorationOptions): Extension {
  const onOpen = (reference: ContextReferenceOccurrence): void => options.onOpen(reference);
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

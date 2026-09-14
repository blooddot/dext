import type * as Monaco from "monaco-editor";
import { atReferenceOccurrences, compactFileReferenceLabel, type ContextReferenceOccurrence } from "../core/fileReference.js";

export interface ProjectedReference {
  viewFrom: number;
  viewTo: number;
  sourceFrom: number;
  sourceTo: number;
  reference: ContextReferenceOccurrence;
}

/** One BMP character per reference makes native selections, multi-cursor edits
 * and undo atomic. The dictionary lives as long as the model's undo history.
 * Only decode() output may leave the editor. No private markers are persisted. */
export class ReferenceProjection {
  private readonly values = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private next = 0xe100;

  reset(): void { this.values.clear(); this.tokens.clear(); this.next = 0xe100; }

  private literal(text: string, source: string): string {
    return Array.from(text, character => {
      if (!this.values.has(character)) return character;
      const key = `literal:${character}`;
      let token = this.tokens.get(key);
      if (!token) {
        while (this.next <= 0xf8ff && source.includes(String.fromCharCode(this.next))) this.next++;
        if (this.next > 0xf8ff) throw new Error("Too many distinct reference tokens in this draft.");
        token = String.fromCharCode(this.next++); this.values.set(token, character); this.tokens.set(key, token);
      }
      return token;
    }).join("");
  }

  encode(source: string): string {
    const refs = atReferenceOccurrences(source);
    let result = "", from = 0;
    for (const ref of refs) {
      result += this.literal(source.slice(from, ref.start), source);
      let token = this.tokens.get(ref.expression);
      if (!token) {
        while (this.next <= 0xf8ff && source.includes(String.fromCharCode(this.next))) this.next++;
        if (this.next <= 0xf8ff) {
          token = String.fromCharCode(this.next++);
          this.values.set(token, ref.expression);
          this.tokens.set(ref.expression, token);
        }
      }
      result += token ?? ref.expression;
      from = ref.end;
    }
    return result + this.literal(source.slice(from), source);
  }

  decode(view: string): string {
    return Array.from(view, character => this.values.get(character) ?? character).join("");
  }

  toSource(view: string, offset: number): number {
    return this.decode(view.slice(0, offset)).length;
  }

  toView(view: string, offset: number, affinity: "left" | "right" = "left"): number {
    let source = 0;
    for (let i = 0; i < view.length; i++) {
      const length = (this.values.get(view[i]!) ?? view[i]!).length;
      if (offset === source) return i;
      if (offset < source + length) return affinity === "right" ? i + 1 : i;
      source += length;
    }
    return view.length;
  }

  references(view: string): ProjectedReference[] {
    const result: ProjectedReference[] = [];
    let source = 0;
    for (let i = 0; i < view.length; i++) {
      const expression = this.values.get(view[i]!);
      if (expression) {
        const reference = atReferenceOccurrences(expression)[0];
        if (reference) result.push({ viewFrom: i, viewTo: i + 1, sourceFrom: source, sourceTo: source + expression.length,
          reference: { ...reference, start: source, end: source + expression.length } });
      }
      source += expression?.length ?? 1;
    }
    return result;
  }
}

export function referenceDecorations(projection: ReferenceProjection, model: Monaco.editor.ITextModel, columns = 20): Monaco.editor.IModelDeltaDecoration[] {
  return projection.references(model.getValue()).map((ref, index) => {
    const from = model.getPositionAt(ref.viewFrom), to = model.getPositionAt(ref.viewTo);
    const full = compactFileReferenceLabel(ref.reference.payload);
    // A bounded label fits a narrow sidebar. The hover always exposes the full path.
    const characters = Array.from(full), width = (character: string) => character.codePointAt(0)! > 255 ? 2 : 1;
    const take = (values: string[], maximum: number) => { let total = 0; return values.filter(character => (total += width(character)) <= maximum); };
    const half = Math.max(1, Math.floor((columns - 2) / 2));
    const label = characters.reduce((sum, character) => sum + width(character), 0) > columns
      ? take(characters, half).join("") + "…" + take([...characters].reverse(), half).reverse().join("") : full;
    return { range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
      options: { description: "dext-reference", inlineClassName: "dext-ref-source", inlineClassNameAffectsLetterSpacing: true,
        stickiness: 1, hoverMessage: { value: ref.reference.payload },
        before: { content: ` ${label} × `.replaceAll(" ", "\u00a0"), inlineClassName: `dext-ref-chip ref-open-${index}`, cursorStops: 3 },
        // Monaco can omit the caret when an inline decoration ends at EOL and
        // only has injected content before its (hidden) source character.
        // Keep a zero-width trailing anchor so the caret remains paintable
        // without adding a separator to the persisted source.
        after: { content: "\u200b", inlineClassName: "dext-ref-cursor-anchor", cursorStops: 3 } } };
  });
}

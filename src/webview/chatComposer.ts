export type ComposerPart =
  | { kind: "text"; value: string }
  | { kind: "attachment"; id: string };

export interface SerializedComposer {
  message: string;
  attachmentIds: string[];
}

export interface ComposerPoint {
  container: Node;
  offset: number;
}

export type ComposerDeleteDirection = "backward" | "forward";

const elementNode = 1;
const textNode = 3;
const blockTags = new Set(["DIV", "P", "LI"]);

function isBlock(node: Node | undefined): node is HTMLElement {
  return node?.nodeType === elementNode
    && blockTags.has((node as HTMLElement).tagName);
}

function attachmentElement(node: Node | undefined): HTMLElement | undefined {
  if (node?.nodeType !== elementNode) return undefined;
  const element = node as HTMLElement;
  return element.dataset.attachmentId ? element : undefined;
}

function childAt(node: Node, index: number): Node | undefined {
  return node.childNodes.item(index) ?? undefined;
}

function childIndex(node: Node): number {
  const parent = node.parentNode;
  if (!parent) return -1;
  return Array.prototype.indexOf.call(parent.childNodes, node);
}

function deepestPoint(node: Node, edge: "start" | "end"): ComposerPoint {
  let current = node;
  while (!attachmentElement(current) && current.childNodes.length > 0) {
    const index = edge === "start" ? 0 : current.childNodes.length - 1;
    const child = childAt(current, index);
    if (!child) break;
    current = child;
  }
  return current.nodeType === textNode
    ? { container: current, offset: edge === "start" ? 0 : (current.textContent ?? "").length }
    : { container: current, offset: edge === "start" ? 0 : current.childNodes.length };
}

/** Keeps a caret saved at the composer root inside its adjacent visual line block. */
export function normalizeComposerPoint(
  root: HTMLElement,
  container: Node,
  offset: number
): ComposerPoint {
  if (container !== root) return { container, offset };
  const boundedOffset = Math.max(0, Math.min(offset, root.childNodes.length));
  const previous = boundedOffset > 0 ? childAt(root, boundedOffset - 1) : undefined;
  if (isBlock(previous)) return deepestPoint(previous, "end");
  const next = childAt(root, boundedOffset);
  if (isBlock(next)) return deepestPoint(next, "start");
  return { container: root, offset: boundedOffset };
}

function editingScope(root: HTMLElement, container: Node): Node {
  let current: Node | null = container.nodeType === textNode ? container.parentNode : container;
  while (current && current !== root) {
    if (isBlock(current)) return current;
    current = current.parentNode;
  }
  return root;
}

function siblingFromBoundary(
  scope: Node,
  container: Node,
  offset: number,
  direction: ComposerDeleteDirection
): Node | undefined {
  if (container.nodeType === textNode) {
    const length = (container.textContent ?? "").length;
    if (direction === "backward" && offset > 0) {
      return container.textContent === "\u200B" ? container : undefined;
    }
    if (direction === "forward" && offset < length) return undefined;
  } else {
    const index = direction === "backward" ? offset - 1 : offset;
    const child = childAt(container, index);
    if (child) return child;
  }

  let current = container;
  while (current !== scope) {
    const parent = current.parentNode;
    if (!parent) return undefined;
    const index = childIndex(current);
    const siblingIndex = direction === "backward" ? index - 1 : index + 1;
    const sibling = childAt(parent, siblingIndex);
    if (sibling) return sibling;
    current = parent;
  }
  return undefined;
}

function attachmentAtEdge(
  node: Node | undefined,
  direction: ComposerDeleteDirection
): HTMLElement | undefined {
  let current = node;
  while (current) {
    const attachment = attachmentElement(current);
    if (attachment) return attachment;
    if (current.nodeType === textNode) {
      if (current.textContent !== "\u200B" || direction !== "backward") return undefined;
      return attachmentElement(current.previousSibling ?? undefined);
    }
    if (isBlock(current) || current.childNodes.length === 0) return undefined;
    const index = direction === "backward" ? current.childNodes.length - 1 : 0;
    current = childAt(current, index);
  }
  return undefined;
}

export function attachmentForComposerDelete(
  root: HTMLElement,
  container: Node,
  offset: number,
  direction: ComposerDeleteDirection
): HTMLElement | undefined {
  const scope = editingScope(root, container);
  return attachmentAtEdge(
    siblingFromBoundary(scope, container, offset, direction),
    direction
  );
}

/** Removes an attachment and its private caret anchor, returning a stable caret point. */
export function removeComposerAttachment(
  root: HTMLElement,
  token: HTMLElement
): ComposerPoint | undefined {
  const parent = token.parentNode;
  if (!parent || (parent !== root && !root.contains(parent))) return undefined;
  let offset = childIndex(token);
  const next = token.nextSibling;
  parent.removeChild(token);
  if (next?.nodeType === textNode && next.textContent === "\u200B") parent.removeChild(next);
  const previous = childAt(parent, offset - 1);
  if (
    previous?.nodeType === textNode
    && previous.textContent === "\u200B"
    && !attachmentElement(previous.previousSibling ?? undefined)
  ) {
    parent.removeChild(previous);
    offset -= 1;
  }
  return { container: parent, offset: Math.max(0, offset) };
}

export function selectedComposerAttachments(root: HTMLElement, range: Range): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-attachment-id]")]
    .filter((token) => range.intersectsNode(token));
}

export function serializeComposerParts(parts: readonly ComposerPart[]): SerializedComposer {
  const attachmentIds: string[] = [];
  let message = "";
  for (const part of parts) {
    if (part.kind === "attachment") attachmentIds.push(part.id);
    else message += part.value.replaceAll("\u200B", "");
  }
  return { message, attachmentIds };
}

function appendText(parts: ComposerPart[], value: string): void {
  if (!value) return;
  const last = parts.at(-1);
  if (last?.kind === "text") last.value += value;
  else parts.push({ kind: "text", value });
}

function endsWithNewline(parts: readonly ComposerPart[]): boolean {
  const lastText = [...parts].reverse().find((part) => part.kind === "text");
  return lastText?.kind === "text" && lastText.value.endsWith("\n");
}

function hasMessageText(parts: readonly ComposerPart[]): boolean {
  return parts.some((part) => part.kind === "text" && part.value.replaceAll("\u200B", "").length > 0);
}

export function composerParts(root: HTMLElement): ComposerPart[] {
  const parts: ComposerPart[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      appendText(parts, node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const current = node as HTMLElement;
    const attachmentId = current.dataset.attachmentId;
    if (attachmentId) {
      parts.push({ kind: "attachment", id: attachmentId });
      return;
    }
    if (current.tagName === "BR") {
      appendText(parts, "\n");
      return;
    }
    const block = ["DIV", "P", "LI"].includes(current.tagName);
    if (block && hasMessageText(parts) && !endsWithNewline(parts)) appendText(parts, "\n");
    current.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return parts;
}

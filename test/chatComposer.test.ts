import { describe, expect, it } from "vitest";
import {
  attachmentForComposerDelete,
  normalizeComposerPoint,
  removeComposerAttachment,
  serializeComposerParts
} from "../src/webview/chatComposer.js";

class FakeNode {
  readonly childNodes: FakeNode[] & { item(index: number): FakeNode | null };
  parentNode: FakeNode | null = null;
  nodeType: number;
  textContent: string | null;
  tagName = "";
  dataset: Record<string, string> = {};

  constructor(nodeType: number, textContent: string | null = null) {
    this.nodeType = nodeType;
    this.textContent = textContent;
    const children = [] as unknown as FakeNode[] & { item(index: number): FakeNode | null };
    children.item = (index) => children[index] ?? null;
    this.childNodes = children;
  }

  get previousSibling(): FakeNode | null {
    const index = this.parentNode?.childNodes.indexOf(this) ?? -1;
    return index > 0 ? this.parentNode?.childNodes[index - 1] ?? null : null;
  }

  get nextSibling(): FakeNode | null {
    const index = this.parentNode?.childNodes.indexOf(this) ?? -1;
    return index >= 0 ? this.parentNode?.childNodes[index + 1] ?? null : null;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  removeChild(node: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("Not a child");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  contains(node: FakeNode | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains(node));
  }
}

function element(tagName: string, attachmentId?: string): FakeNode {
  const node = new FakeNode(1);
  node.tagName = tagName;
  if (attachmentId) node.dataset.attachmentId = attachmentId;
  return node;
}

function text(value: string): FakeNode {
  return new FakeNode(3, value);
}

function dom<T>(value: FakeNode): T {
  return value as unknown as T;
}

describe("Chat composer serialization", () => {
  it("excludes token labels while retaining text and attachment DOM order", () => {
    expect(serializeComposerParts([
      { kind: "text", value: "Review " },
      { kind: "attachment", id: "selection" },
      { kind: "text", value: " before " },
      { kind: "attachment", id: "file" },
      { kind: "text", value: "\nplease\u200B" }
    ])).toEqual({
      message: "Review  before \nplease",
      attachmentIds: ["selection", "file"]
    });
  });

  it("normalizes a root block boundary to the end of the current visual line", () => {
    const root = element("DIV");
    const line = element("DIV");
    const content = text("不知道");
    line.append(content);
    root.append(line);

    expect(normalizeComposerPoint(dom<HTMLElement>(root), dom<Node>(root), 1)).toEqual({
      container: content,
      offset: 3
    });
  });

  it("finds an attachment atomically for Backspace through its caret anchor", () => {
    const root = element("DIV");
    const line = element("DIV");
    const before = text("不知道");
    const token = element("SPAN", "selection");
    const caret = text("\u200B");
    const after = text("好");
    line.append(before, token, caret, after);
    root.append(line);

    expect(attachmentForComposerDelete(
      dom<HTMLElement>(root),
      dom<Node>(caret),
      1,
      "backward"
    )).toBe(token);
    expect(attachmentForComposerDelete(
      dom<HTMLElement>(root),
      dom<Node>(after),
      0,
      "backward"
    )).toBe(token);
  });

  it("finds an attachment atomically for Delete and removes its private anchor", () => {
    const root = element("DIV");
    const line = element("DIV");
    const before = text("检查");
    const token = element("SPAN", "selection");
    const caret = text("\u200B");
    const after = text("结果");
    line.append(before, token, caret, after);
    root.append(line);

    expect(attachmentForComposerDelete(
      dom<HTMLElement>(root),
      dom<Node>(before),
      2,
      "forward"
    )).toBe(token);
    expect(removeComposerAttachment(dom<HTMLElement>(root), dom<HTMLElement>(token))).toEqual({
      container: line,
      offset: 1
    });
    expect(line.childNodes).toHaveLength(2);
    expect(line.childNodes[0]).toBe(before);
    expect(line.childNodes[1]).toBe(after);
  });
});

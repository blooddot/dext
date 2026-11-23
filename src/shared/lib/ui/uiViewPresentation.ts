import { uiViewResultSchema, type UiNode } from "../../contracts/uiView.js";
import { Alert } from "./feedback/feedbackComponents.js";
import { Button } from "./input/nativeControls.js";
import { Empty } from "./feedback/feedbackComponents.js";
import { Inline, Section, Stack } from "./layout/layoutComponents.js";
import { Badge, Spinner } from "./feedback/feedbackComponents.js";
import {
  Code, CodeBlock, Markdown,
  Separator, Text, inertMarkdownText
} from "./content/contentComponents.js";
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./content/traceComponents.js";
import type { MarkupAdapter } from "./renderAdapter.js";

export function renderUiView<E>(adapter: MarkupAdapter<E>, payload: unknown): E | undefined {
  const view = uiViewResultSchema.safeParse(payload);
  if (!view.success) return undefined;
  const render = (node: UiNode, sectionLevel: 3 | 4 | 5 | 6): E => {
    switch (node.type) {
      case "Stack":
        return Stack(adapter, node.children.map((child) => render(child, sectionLevel)), { gap: node.gap });
      case "Inline":
        return Inline(adapter, node.children.map((child) => render(child, sectionLevel)), { gap: node.gap, wrap: node.wrap });
      case "Section": {
        const next = sectionLevel === 6 ? 6 : (sectionLevel + 1) as 4 | 5 | 6;
        return Section(adapter, node.children.map((child) => render(child, next)), {
          title: node.title, description: node.description, level: sectionLevel
        });
      }
      case "Empty":
        return Empty(adapter, node.text);
      case "Trace":
        return Trace(adapter, node.children.map((child) => render(child, sectionLevel)), {}, node.ordered ? "ol" : "ul");
      case "TraceLine":
        return TraceLine(adapter, node.children.map((child) => render(child, sectionLevel)), {
          "data-status": node.status ?? false,
          ...(node.tone ? { class: `agent-result-detail ${node.tone}` } : {})
        });
      case "TraceIcon":
        return TraceIcon(adapter, node.icon);
      case "TraceTitle":
        return TraceTitle(adapter, [node.text], { class: "agent-result-title" });
      case "TraceDescription":
        return TraceDescription(adapter, [node.text], { class: `agent-result-meta${node.tone ? ` ${node.tone}` : ""}` });
      case "Text":
        return adapter.element("span", node.tone ? { class: `agent-result-detail ${node.tone}` } : {}, [Text(node.text)]);
      case "Markdown":
        return Markdown(adapter, node.source, { trustedLinks: false });
      case "Code":
        return Code(adapter, node.text);
      case "CodeBlock":
        return adapter.element("div", { class: "output-copyable" }, [
          CodeBlock(adapter, node.code),
          Button(adapter, { class: "copy-button codicon codicon-copy", "aria-label": "Copy", title: "Copy", disabled: true })
        ]);
      case "Separator":
        return Separator(adapter);
      case "Badge":
        return Badge(adapter, node.text, {
          class: "agent-todo-status", "data-status": node.status ?? false, "data-ui-tone": node.tone ?? false
        });
      case "Spinner":
        return adapter.element("span", {}, [Spinner(adapter, { class: "codicon codicon-loading" }), " ", node.label]);
      case "Alert":
        return Alert(adapter, node.text, { role: false, class: `agent-result-detail ${node.tone ?? "info"}` });
    }
  };
  return adapter.element("div", { "data-script-view": true }, view.data.nodes.map((node) =>
    node.type === "TraceLine" ? Trace(adapter, [render(node, 3)]) : render(node, 3)));
}

export function uiViewText(payload: unknown): string {
  const view = uiViewResultSchema.safeParse(payload);
  if (!view.success) return "";
  const text = (node: UiNode): string => {
    switch (node.type) {
      case "Stack":
      case "Inline":
      case "Trace":
      case "TraceLine": return node.children.map(text).filter(Boolean).join("\n");
      case "Section": return [node.title, node.description, ...node.children.map(text)].filter(Boolean).join("\n");
      case "Markdown": return inertMarkdownText(node.source);
      case "CodeBlock": return node.code;
      case "Spinner": return node.label;
      case "Separator":
      case "TraceIcon": return "";
      default: return node.text;
    }
  };
  return view.data.nodes.map(text).filter(Boolean).join("\n\n");
}

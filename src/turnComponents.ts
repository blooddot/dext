import type { DextResult, PatchChange } from "./core/types.js";
import type { TurnSectionPresentation } from "./turnPresentation.js";
import { uiResultText } from "./uiInteractionPresentation.js";
import type { AgentMessagePresentation } from "./agentMessagePresentation.js";

/** Only the output medium differs: text is escaped by HTML and appended as text by DOM. */
export interface TurnRenderAdapter<E> {
  element(this: void, tag: string, attributes: Record<string, string | boolean>, children: readonly (E | string)[]): E;
}

export function renderTurnSection<E>(
  adapter: TurnRenderAdapter<E>, section: TurnSectionPresentation, children: readonly E[] = [],
  open = false
): { disclosure: E; body: E; meta: E } {
  const el = adapter.element;
  const meta = section.kind === "input"
    ? el("span", { class: "turn-mode", "data-mode": section.mode.value, title: section.mode.title }, [section.mode.label])
    : el("span", { class: "turn-section-meta disclosure-meta" }, [section.kind === "process" ? section.detail ?? "" : ""]);
  const summary = el("summary", {}, [
    el("i", { class: "disclosure-chevron codicon codicon-chevron-right" }, []),
    el("span", {}, [section.label]), meta
  ]);
  const body = el("div", { class: "turn-section-body" }, children);
  return { disclosure: el("details", { class: "turn-section", "data-turn-section": section.kind, open }, [summary, body]), body, meta };
}

/** Copy controls and content use identical layout in both views. */
export function renderTurnInput<E>(adapter: TurnRenderAdapter<E>, source: E, copy: E): E {
  return adapter.element("div", { class: "output-turn-input" }, [source, copy]);
}

export function renderTurnMarkdown<E>(adapter: TurnRenderAdapter<E>, body: E, copy: E): E {
  return adapter.element("div", { class: "output-text-copyable" }, [
    adapter.element("div", { class: "markdown-copy-toolbar" }, [copy]), body
  ]);
}

export interface TurnResultAdapter<E> extends TurnRenderAdapter<E> {
  markdown(text: string): E;
  json(text: string): E;
  terminal(text: string, stderr: boolean): E;
  patch(change: PatchChange): E;
  plan(path: string): E;
}

/** One result dispatch and layout policy for History and Conversation. Host actions
 * (open a plan, review a patch, copy output) remain callbacks on the adapters. */
export function renderTurnResult<E>(adapter: TurnResultAdapter<E>, result: DextResult): E[] {
  const title = (text: string): E => adapter.element("div", { class: "output-title" }, [text]);
  if (result.kind === "ask" || result.kind === "plan" || result.kind === "skill") {
    return [adapter.markdown(result.text), ...(result.kind === "plan" && result.planPath ? [adapter.plan(result.planPath)] : [])];
  }
  if (result.kind === "agent") return [
    ...(result.text ? [adapter.markdown(result.text)] : []),
    ...(result.patch?.changes ?? []).map((change) => adapter.patch(change))
  ];
  if (result.kind === "apply") return [adapter.markdown(`${result.status}: ${result.summary}`)];
  if (result.kind === "print") return [...(result.label ? [title(result.label)] : []), adapter.json(result.text)];
  if (result.kind === "patch") return [title(result.title), ...result.changes.map((change) => adapter.patch(change))];
  if (result.kind === "terminal") {
    const el = adapter.element;
    return [el("details", { class: "execution-disclosure terminal-disclosure" }, [
      el("summary", {}, [
        el("i", { class: "disclosure-chevron codicon codicon-chevron-right" }, []),
        el("span", {}, [result.command]),
        el("span", { class: "disclosure-meta" }, [`${result.status} | exit ${result.exit_code}`])
      ]),
      el("div", { class: "execution-disclosure-body" }, [
        el("div", { class: "result-meta" }, [result.cwd]),
        ...(result.stdout ? [adapter.terminal(result.stdout, false)] : []),
        ...(result.stderr ? [adapter.terminal(result.stderr, true)] : [])
      ])
    ])];
  }
  if (result.kind === "ui") return [adapter.markdown(uiResultText(result))];
  return [adapter.json(JSON.stringify(result, null, 2))];
}

export interface TurnHtml { readonly html: string }

export interface TurnMessageAdapter<E> extends TurnRenderAdapter<E> {
  prose(text: string): E;
  code(text: string): E;
  patch(change: PatchChange): E;
}

/** Process messages share structure too; the live view only owns when to update them. */
export function renderTurnMessage<E>(adapter: TurnMessageAdapter<E>, message: AgentMessagePresentation): E[] {
  if (!message.structured) return [adapter.prose(message.text)];
  const el = adapter.element;
  const disclosure = (label: string, detail: string, className: string, children: E[]): E => el("details", { class: className }, [
    el("summary", {}, [el("i", { class: "disclosure-chevron codicon codicon-chevron-right" }, []),
      el("span", {}, [label]), el("span", { class: "disclosure-meta" }, [detail])]), ...children
  ]);
  return [el("section", { class: `agent-result process-result-${message.kind}` }, [
    el("div", { class: "agent-result-heading" }, [
      el("span", { class: "agent-result-title" }, [message.title]),
      ...(message.meta.length ? [el("span", { class: "agent-result-meta" }, [message.meta.join(" · ")])] : [])
    ]),
    ...(message.text ? [adapter.prose(message.text)] : []),
    ...message.details.map((detail) => el("div", { class: `agent-result-detail ${detail.tone}` }, [
      ...(detail.meta ? [el("span", { class: "agent-result-detail-meta" }, [detail.meta])] : []), detail.text
    ])),
    ...message.changes.map((change) => adapter.patch(change)),
    ...message.references.map((reference) => disclosure(reference.uri.replaceAll("\\", "/").split("/").pop() ?? reference.uri,
      [reference.location, reference.symbol].filter(Boolean).join(" · "), "agent-result-reference", [
        el("div", { class: "agent-file-path" }, [reference.uri]),
        ...(reference.content ? [adapter.code(reference.content)] : [])
      ])),
    ...message.sections.map((section) => disclosure(section.title, "", `agent-result-section ${section.tone}`, [
      el("div", { class: "agent-result-section-body" }, [section.code ? adapter.code(section.text) : adapter.prose(section.text)])
    ]))
  ])];
}

export function escapeTurnHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export const turnHtmlAdapter: TurnRenderAdapter<TurnHtml> = {
  element: (tag, attributes, children) => ({
    html: `<${tag}${Object.entries(attributes).filter(([, value]) => value !== false).map(([key, value]) =>
      value === true ? ` ${key}` : ` ${key}="${escapeTurnHtml(String(value))}"`).join("")}>${children.map((child) =>
      typeof child === "string" ? escapeTurnHtml(child) : child.html).join("")}</${tag}>`
  })
};

/** The document is injected so importing shared components never requires a browser. */
export function turnDomAdapter(document: Document): TurnRenderAdapter<HTMLElement> {
  return {
    element: (tag, attributes, children) => {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== false) element.setAttribute(key, value === true ? "" : value);
      }
      element.append(...children);
      return element;
    }
  };
}

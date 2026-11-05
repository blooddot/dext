import type { ApplyResult, DextResult } from "../../../shared/contracts/types.js";
import type { TurnModePresentation, TurnRenderModel } from "./turnPresentation.js";
import { uiResultText } from "./uiInteractionPresentation.js";
import type { AgentMessagePresentation } from "./agentMessagePresentation.js";
import { formatJsonOutput } from "../../../shared/lib/jsonOutput.js";
import { escapeHtml as escapeTurnHtml } from "../../../shared/lib/html.js";

/** Only the output medium differs: text is escaped by HTML and appended as text by DOM. */
export interface TurnRenderAdapter<E> {
  element(this: void, tag: string, attributes: Record<string, string | boolean>, children: readonly (E | string)[]): E;
}

/** The process line: one light `Worked …` row that unfolds into the timeline.
 * It never renders a section label of its own. */
export function renderTurnSection<E>(
  adapter: TurnRenderAdapter<E>, process: TurnRenderModel["process"], children: readonly E[] = [],
  open = false, action?: E
): { disclosure: E; body: E; meta: E } {
  const el = adapter.element;
  const meta = el("span", { class: "turn-section-meta disclosure-meta" }, [process.detail ?? ""]);
  const summary = el("summary", {}, [
    el("i", { class: "disclosure-chevron codicon codicon-chevron-right" }, []),
    meta,
    ...(action ? [el("span", { class: "turn-section-actions" }, [action])] : [])
  ]);
  const body = el("div", { class: "turn-section-body" }, children);
  return { disclosure: el("details", { class: "turn-section", "data-turn-section": "process", open }, [summary, body]), body, meta };
}

/** The answer is never a fold target: one divider separates it from the timeline. */
export function renderTurnOutput<E>(adapter: TurnRenderAdapter<E>, children: readonly E[], copy?: E): { section: E; body: E } {
  const el = adapter.element;
  const body = el("div", { class: "turn-output-body" }, children);
  return {
    section: el("section", { class: "turn-output", "data-turn-section": "output" }, [...(copy ? [copy] : []), body]),
    body
  };
}

/** The submitted mode is plain metadata beside the prompt, not a pill. */
export function renderTurnMode<E>(adapter: TurnRenderAdapter<E>, mode: TurnModePresentation): E {
  return adapter.element("span", { class: "turn-mode", "data-mode": mode.value, title: mode.title }, [mode.label]);
}

/** Copy controls belong to the section title bar, not to the content they copy. */
export function renderTurnMarkdown<E>(adapter: TurnRenderAdapter<E>, body: E): E {
  return adapter.element("div", { class: "output-text-copyable" }, [body]);
}

/** A literal JSON view shared by both hosts. Copy always receives the raw source
 * and sits in the JSON title bar, so it stays exact even when Output has more
 * than one result. */
export function renderTurnJson<E>(adapter: TurnRenderAdapter<E>, text: string, copy?: E): E | undefined {
  const formatted = formatJsonOutput(text);
  if (formatted === undefined) return undefined;
  const el = adapter.element;
  return el("div", { class: "output-text-copyable json-output" }, [
    el("details", { class: "execution-disclosure json-disclosure", open: true }, [
      el("summary", {}, [
        el("i", { class: "disclosure-chevron codicon codicon-chevron-right" }, []), "JSON",
        ...(copy ? [copy] : [])
      ]),
      el("pre", { class: "json-output-text" }, [el("code", {}, [formatted])])
    ])
  ]);
}

export interface TurnResultAdapter<E> extends TurnRenderAdapter<E> {
  markdown(text: string): E;
  json(text: string): E;
  plan(path: string): E;
}

/** One result dispatch and layout policy for History and Conversation. Host actions
 * (open a plan, copy output) remain callbacks on the adapters. */
export function renderTurnResult<E>(adapter: TurnResultAdapter<E>, result: DextResult, patchApplication?: ApplyResult): E[] {
  const textOutput = (text: string): E => formatJsonOutput(text) === undefined ? adapter.markdown(text) : adapter.json(text);
  if (result.kind === "ask" || result.kind === "plan" || result.kind === "skill" || result.kind === "template") {
    return [textOutput(result.text), ...(result.kind === "plan" && result.planPath ? [adapter.plan(result.planPath)] : [])];
  }
  if (result.kind === "agent") return [
    ...(result.text ? [textOutput(result.text)] : []),
    ...(patchApplication ? [adapter.element("div", {
      class: `patch-application ${patchApplication.status}`,
      role: patchApplication.status === "conflict" ? "alert" : "status"
    }, [patchApplication.status === "applied"
      ? `Automatically applied changes to ${patchApplication.files.length} file${patchApplication.files.length === 1 ? "" : "s"}.`
      : `Auto-apply ${patchApplication.status}: ${patchApplication.summary}`])] : result.patch ? [adapter.element("div", {
      class: "patch-application ignored", role: "status"
    }, ["Legacy patch ignored; no files were written when loading this conversation."])] : [])
  ];
  if (result.kind === "apply") return [adapter.markdown(`${result.status}: ${result.summary}`)];
  // terminal 的返回值是给 API 读的，不进 Output；要给人看就由 API 自己 console.log。
  if (result.kind === "terminal") return [];
  if (result.kind === "ui") return [adapter.markdown(uiResultText(result))];
  // 没有 kind 的普通返回值同样不进 Output：要给人看就由 API 自己 console.log。
  const declared = typeof (result as { kind?: unknown }).kind === "string";
  return declared ? [adapter.json(JSON.stringify(result, null, 2))] : [];
}

export interface TurnHtml { readonly html: string }

export interface TurnMessageAdapter<E> extends TurnRenderAdapter<E> {
  prose(text: string): E;
  code(text: string): E;
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

export { escapeTurnHtml };

export const turnHtmlAdapter: TurnRenderAdapter<TurnHtml> = {
  element: (tag, attributes, children) => ({
    html: `<${tag}${Object.entries(attributes).filter(([, value]) => value !== false).map(([key, value]) =>
      value === true ? ` ${key}` : ` ${key}="${escapeTurnHtml(String(value))}"`).join("")}>${children.map((child) =>
      typeof child === "string" ? escapeTurnHtml(child) : child.html).join("")}</${tag}>`
  })
};

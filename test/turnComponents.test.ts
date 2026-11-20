import { describe, expect, it, vi } from "vitest";
import { defaultTreeAdapter, html, parseFragment, serializeOuter } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { renderTurnResult, renderTurnSection, renderTurnMode, renderTurnOutput, renderTurnMessage, renderTurnJson } from "../src/features/conversations/presentation/turnComponents.js";
import { htmlUiAdapter } from "../src/shared/lib/ui/htmlUiAdapter.js";
import { domUiAdapter } from "../src/platform/browser/domUiAdapter.js";
import {
  Badge, Code, CodeBlock, Markdown, Separator, Spinner, Text,
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle
} from "../src/shared/lib/ui/traceComponents.js";
import type { MarkupAdapter } from "../src/shared/lib/ui/renderAdapter.js";
import { presentTurn, presentTurnMode, resultCopyText } from "../src/features/conversations/presentation/turnPresentation.js";
import type { UiViewResult } from "../src/shared/contracts/uiView.js";
import { presentAgentMessage } from "../src/features/conversations/presentation/agentMessagePresentation.js";

type ParsedElement = DefaultTreeAdapterTypes.Element;

// Use the existing HTML parser as the document's tree storage. The production
// DOM adapter still drives creation, attribute writes, and text insertion.
function parsedDocument(): Document {
  return {
    createElement(tag: string) {
      const node = defaultTreeAdapter.createElement(tag, html.NS.HTML, []);
      return Object.assign(node, {
        setAttribute: (name: string, value: string) => node.attrs.push({ name, value }),
        append: (...children: (string | ParsedElement)[]) => {
          for (const child of children) {
            if (typeof child === "string") defaultTreeAdapter.insertText(node, child);
            else defaultTreeAdapter.appendChild(node, child);
          }
        },
        insertAdjacentHTML: (_position: "afterbegin", source: string) => {
          for (const child of parseFragment(node, source, {}).childNodes) defaultTreeAdapter.appendChild(node, child);
        }
      });
    }
  } as unknown as Document;
}

function presentation<E>(adapter: MarkupAdapter<E>, interactive: boolean): E {
  const literal = Text('<img src=x onerror="bad"> & "quotes"');
  return adapter.element("section", { open: true, hidden: false, "aria-expanded": "false", title: literal }, [
    adapter.element("input", { type: "checkbox", checked: true, disabled: !interactive }, []),
    Separator(adapter),
    literal,
    Code(adapter, literal),
    CodeBlock(adapter, literal),
    Badge(adapter, "Completed", { "data-status": "completed" }),
    Spinner(adapter, {}, "Loading"),
    Markdown(adapter, "[label](file:///example.md) [bad](javascript:alert%281%29) ![alt < &](https://example.org/image.png)\n\n" + literal,
      { trustedLinks: interactive })
  ]);
}

function comparableStructure(source: string) {
  return parseFragment(source).childNodes.map((node) => serializeOuter(node));
}

function planFixture<E>(adapter: MarkupAdapter<E>, interactive: boolean): E {
  const task = TraceLine(adapter, [
    TraceIcon(adapter, "check"),
    TraceTitle(adapter, [
      Markdown(adapter, "**Check** the output.", { trustedLinks: true }),
      TraceDescription(adapter, ["verify: npm test"], { class: "agent-todo-verify" }, "div")
    ], { class: "agent-todo-text" }, "div"),
    Badge(adapter, "Completed", { class: "agent-todo-status" })
  ], { class: "agent-todo-item", "data-status": "completed" });
  const phase = TraceCollapsible(adapter, TraceCollapsibleTrigger(adapter, [
    TraceIcon(adapter, "chevron-right"), TraceTitle(adapter, ["Build"]), TraceDescription(adapter, ["1/1"])
  ], { class: "agent-todo-item" }), TraceCollapsibleContent(adapter, [
    Trace(adapter, [task], { class: "agent-todo-list" })
  ]));
  const acceptanceRow = TraceLine(adapter, [
    adapter.element("input", { id: "acceptance-a", type: "checkbox", checked: true, disabled: !interactive }, []),
    adapter.element("label", { for: "acceptance-a" }, ["Review output"])
  ], { class: "agent-acceptance-item" });
  return TraceCollapsible(adapter, TraceCollapsibleTrigger(adapter, [
    TraceIcon(adapter, "chevron-right"), TraceTitle(adapter, ["Todo"]), TraceDescription(adapter, ["1/1 completed"])
  ]), TraceCollapsibleContent(adapter, [
    Trace(adapter, [TraceLine(adapter, [phase], { class: "agent-todo-group" })], { class: "agent-todo-list" }),
    Trace(adapter, [acceptanceRow], { class: "agent-acceptance-list" })
  ]), { class: "agent-todos", open: true });
}

function traceFixture<E>(adapter: MarkupAdapter<E>, interactive: boolean): E {
  const details = TraceCollapsible(adapter, TraceCollapsibleTrigger(adapter, [
    TraceIcon(adapter, "chevron-right"), TraceTitle(adapter, ["example.ts"]), TraceDescription(adapter, ["2:3"])
  ]), TraceCollapsibleContent(adapter, [CodeBlock(adapter, "const value = 1;")]), { class: "agent-result-reference" });
  const json = TraceCollapsible(adapter, TraceCollapsibleTrigger(adapter, [
    TraceIcon(adapter, "chevron-right"), TraceTitle(adapter, ["JSON"]),
    adapter.element("button", { disabled: !interactive }, ["Copy"])
  ]), TraceCollapsibleContent(adapter, [CodeBlock(adapter, '{"value":1}')]), { class: "json-disclosure", open: true });
  const process = TraceCollapsible(adapter, TraceCollapsibleTrigger(adapter, [
    TraceIcon(adapter, "terminal"), TraceTitle(adapter, ["Ran 1 command"]), TraceDescription(adapter, ["10ms"])
  ]), TraceCollapsibleContent(adapter, [Trace(adapter, [
    TraceLine(adapter, [TraceDescription(adapter, ["stdout"]), Text("Finished"), details, json],
      { class: "agent-result-detail" })
  ], { class: "agent-trace-tool-body" }, "div")]), { class: "agent-trace-tool" });
  return Trace(adapter, [TraceLine(adapter, [process], {}, "div")], { class: "turn-section-body" }, "div");
}

describe("shared view primitives", () => {
  it.each([true, false])("produces equivalent parsed markup and DOM for interactive=%s", (interactive) => {
    const staticMarkup = presentation(htmlUiAdapter, interactive).html;
    const dom = presentation(domUiAdapter(parsedDocument()), interactive);
    expect(comparableStructure(staticMarkup)).toEqual([serializeOuter(dom as unknown as ParsedElement)]);
    expect(staticMarkup).toContain(`<input type="checkbox" checked${interactive ? "" : " disabled"}><hr>`);
    expect(staticMarkup).toContain('open aria-expanded="false"');
    expect(staticMarkup).not.toMatch(/<\/(?:input|hr)>| hidden|<img src=x/);
    expect(staticMarkup).toContain('<code>&lt;img');
    expect(staticMarkup).toContain('role="status" aria-label="Loading"');
  });

  it("keeps trusted links while making script destinations and images inert", () => {
    const trusted = presentation(htmlUiAdapter, true).html;
    expect(trusted).toContain('href="file:///example.md"');
    expect(trusted).not.toContain('href="javascript:');
    const inert = presentation(htmlUiAdapter, false).html;
    expect(inert).toContain('label bad alt &lt; &amp;');
    expect(inert).not.toMatch(/<a\b|<img\b|\b(?:href|src)=["']/);
  });

  it("preserves the trusted Markdown host's fenced-code copy control", () => {
    const source = "```ts\nconst n = 1;\n```";
    const options = { trustedLinks: true, copyCode: true };
    const staticMarkup = Markdown(htmlUiAdapter, source, options).html;
    const dom = Markdown(domUiAdapter(parsedDocument()), source, options);
    expect(comparableStructure(staticMarkup)).toEqual([serializeOuter(dom as unknown as ParsedElement)]);
    expect(staticMarkup).toContain('class="markdown-code-copy codicon codicon-copy"');
    expect(staticMarkup).toContain('class="language-ts"');
  });

  it.each([["Plan", planFixture], ["agent trace", traceFixture]] as const)(
    "composes %s with matching tags, classes, attributes, and nesting", (name, fixture) => {
      const live = fixture(htmlUiAdapter, true).html;
      const readonly = fixture(htmlUiAdapter, false).html;
      for (const [interactive, source] of [[true, live], [false, readonly]] as const) {
        const dom = fixture(domUiAdapter(parsedDocument()), interactive);
        expect(comparableStructure(source)).toEqual([serializeOuter(dom as unknown as ParsedElement)]);
      }
      expect(readonly.match(/ disabled(?=>)/g)).toHaveLength(1);
      expect(comparableStructure(readonly.replace(" disabled>", ">"))).toEqual(comparableStructure(live));
      expect(live).toContain('<summary');
      expect(live).toContain('aria-hidden="true"');
      if (name === "Plan") {
        expect(live).toContain('<input id="acceptance-a" type="checkbox" checked><label for="acceptance-a">');
        expect(live).toContain('verify: npm test');
      } else {
        expect(live).toContain('<div role="listitem">');
        expect(live).toContain('agent-result-reference');
      }
    }
  );
});

describe("shared turn rendering", () => {
  it("escapes model text and gives only Process an elapsed-time field", () => {
    const model = presentTurn({ durationMs: 1000 });
    const mode = renderTurnMode(htmlUiAdapter, presentTurnMode("agent"));
    expect(mode.html).toContain('data-mode="agent"');
    expect(mode.html).toContain("Submitted in Agent mode");
    expect(renderTurnMode(htmlUiAdapter, presentTurnMode("ask")).html).toContain(">Ask<");
    model.process.detail = '<img src=x onerror="alert(1)">';
    const process = renderTurnSection(htmlUiAdapter, model.process).disclosure.html;
    expect(process).toContain("&lt;img");
    expect(process).not.toContain("<img");
    const output = renderTurnOutput(htmlUiAdapter, [{ html: "<p>answer</p>" }], { html: "<button></button>" }).section.html;
    expect(output).not.toContain("Worked");
    expect(output).not.toContain("<summary");
  });

  it("keeps section actions in the title bar after its metadata", () => {
    const model = presentTurn({ durationMs: 1_000 });
    const action = htmlUiAdapter.element("button", { class: "copy-button" }, []);
    const html = renderTurnSection(htmlUiAdapter, model.process, [], true, action).disclosure.html;
    const summary = html.slice(0, html.indexOf("</summary>"));
    expect(summary).toContain('class="turn-section-actions"');
    expect(summary).toContain('class="copy-button"');
    expect(summary.indexOf("Worked for")).toBeLessThan(summary.indexOf("turn-section-actions"));
    expect(html.slice(html.indexOf("</summary>"))).not.toContain("copy-button");
  });

  function resultAdapter() {
    const literal = (text: string) => htmlUiAdapter.element("span", {}, [text]);
    return {
      ...htmlUiAdapter, markdown: vi.fn(literal), json: vi.fn(literal),
      patch: vi.fn((change: { uri: string }) => literal(change.uri)), plan: vi.fn(literal)
    };
  }

  it.each(["ask", "agent", "plan", "skill", "template"] as const)("routes complete %s JSON to the JSON adapter with its exact original text", (kind) => {
    const text = ' \r\n' + JSON.stringify([{ 中文: '第一行\n"引号" C:\\path **bold** `code` <img src=x>', long: "x".repeat(4000) }]) + '\r\n ';
    const result = Object.freeze({ kind, text });
    const adapter = resultAdapter();
    renderTurnResult(adapter, result);
    expect(adapter.json).toHaveBeenCalledWith(text);
    expect(adapter.markdown).not.toHaveBeenCalled();
    expect(result.text).toBe(text);
    const html = renderTurnJson(htmlUiAdapter, text, { html: "copy" })!.html;
    expect(html).toContain('json-disclosure" open');
    expect(html).toContain('class="json-output-text"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<strong>');
  });

  it.each(['# Heading\n\n**bold**', '{"partial":', '{invalid}', 'Here is {"x":1}', '```json\n{}\n```'])("preserves Markdown dispatch for %s", (text) => {
    const adapter = resultAdapter();
    renderTurnResult(adapter, { kind: "ask", text });
    expect(adapter.markdown).toHaveBeenCalledWith(text);
    expect(adapter.json).not.toHaveBeenCalled();
  });

  it("ignores legacy Agent patches and dispatches Plan links without granting actions to History", () => {
    const adapter = resultAdapter();
    const change = { uri: "a.ts", before: "old", after: "new" };
    renderTurnResult(adapter, { kind: "agent", text: "Answer", patch: { kind: "patch", title: "Edit", changes: [change] } });
    expect(adapter.markdown).toHaveBeenCalledWith("Answer");
    expect(adapter.patch).not.toHaveBeenCalled();
    renderTurnResult(adapter, { kind: "plan", text: "Plan", planPath: "plans/a.md" });
    expect(adapter.plan).toHaveBeenCalledWith("plans/a.md");
  });

  it("keeps a typed MCP payload visible instead of dropping its kind", () => {
    const adapter = resultAdapter();
    renderTurnResult(adapter, { kind: "mcp.custom", answer: "kept" });
    expect(adapter.json).toHaveBeenLastCalledWith(JSON.stringify({ kind: "mcp.custom", answer: "kept" }, null, 2));
  });

  it("keeps terminal results out of Output so the API decides what people see", () => {
    const adapter = resultAdapter();
    const nodes = renderTurnResult(adapter, { kind: "terminal", command: "git status", cwd: ".",
      status: "failed", exit_code: 1, stdout: "output", stderr: "error", duration_ms: 1234 });
    expect(nodes).toEqual([]);
    expect(adapter.json).not.toHaveBeenCalled();
  });

  it("keeps a plain return value out of Output and still shows a typed MCP payload", () => {
    const adapter = resultAdapter();
    expect(renderTurnResult(adapter, { ready: true, blockers: [] } as never)).toEqual([]);
    expect(adapter.json).not.toHaveBeenCalled();
  });

  it("uses the same readable structured Process content for both adapters", () => {
    const prose = vi.fn((text: string) => htmlUiAdapter.element("p", {}, [text]));
    const content = renderTurnMessage({ ...htmlUiAdapter, prose, code: prose },
      presentAgentMessage(JSON.stringify({ kind: "agent", text: "Readable answer", patch: { kind: "patch", title: "Edit", changes: [{ uri: "a", before: "b", after: "c" }] } })));
    expect(content[0]?.html).toContain("Readable answer");
    expect(content[0]?.html).not.toContain("data-diff");
    expect(content[0]?.html).not.toContain('&quot;kind&quot;');
  });

  it("renders the same inert display structure on every redraw and copies only its visible text", () => {
    const result: UiViewResult = { kind: "view", nodes: [
      { type: "Markdown", source: "**First** [link](https://example.org/hidden) [bad](javascript:alert%281%29) ![alt](https://example.org/image)" },
      { type: "Trace", ordered: true, children: [{ type: "TraceLine", children: [
        { type: "TraceTitle", text: "Second" }, { type: "TraceDescription", text: "Details" }, { type: "CodeBlock", code: "<test>" }
      ] }] }, { type: "Spinner", label: "Pending" }
    ] };
    const expected = renderTurnResult(resultAdapter(), result)[0]!.html;
    expect(expected).toContain("<strong>First</strong> link bad alt");
    expect(expected).toContain("<ol><li>");
    expect(expected).toContain("<code>&lt;test&gt;</code>");
    expect(expected).toMatch(/<button[^>]+aria-label="Copy"[^>]+disabled>/);
    expect(expected).not.toMatch(/<a\b|<img\b|data-copy|example\.org|javascript:|codicon-modifier-spin/);
    const domAdapter = domUiAdapter(parsedDocument());
    const literal = (text: string) => domAdapter.element("span", {}, [text]);
    const adapter = { ...domAdapter, markdown: literal, json: literal, plan: literal };
    for (let redraw = 0; redraw < 2; redraw++) {
      const display = renderTurnResult(adapter, result);
      expect(display).toHaveLength(1);
      expect(comparableStructure(expected)).toEqual([serializeOuter(display[0] as unknown as ParsedElement)]);
    }
    expect(resultCopyText(result)).toBe("First link bad alt\n\nSecond\nDetails\n<test>\n\nPending");
  });
});

import { describe, expect, it, vi } from "vitest";
import { renderTurnResult, renderTurnSection, renderTurnMode, renderTurnOutput, renderTurnMessage, renderTurnJson, turnHtmlAdapter } from "../src/features/conversations/presentation/turnComponents.js";
import { presentTurn, presentTurnMode } from "../src/features/conversations/presentation/turnPresentation.js";
import { presentAgentMessage } from "../src/features/conversations/presentation/agentMessagePresentation.js";

describe("shared turn rendering", () => {
  it("escapes model text and gives only Process an elapsed-time field", () => {
    const model = presentTurn({ durationMs: 1000 });
    const mode = renderTurnMode(turnHtmlAdapter, presentTurnMode("agent"));
    expect(mode.html).toContain('data-mode="agent"');
    expect(mode.html).toContain("Submitted in Agent mode");
    expect(renderTurnMode(turnHtmlAdapter, presentTurnMode("ask")).html).toContain(">Ask<");
    model.process.detail = '<img src=x onerror="alert(1)">';
    const process = renderTurnSection(turnHtmlAdapter, model.process).disclosure.html;
    expect(process).toContain("&lt;img");
    expect(process).not.toContain("<img");
    const output = renderTurnOutput(turnHtmlAdapter, [{ html: "<p>answer</p>" }], { html: "<button></button>" }).section.html;
    expect(output).not.toContain("Worked");
    expect(output).not.toContain("<summary");
  });

  it("keeps section actions in the title bar after its metadata", () => {
    const model = presentTurn({ durationMs: 1_000 });
    const action = turnHtmlAdapter.element("button", { class: "copy-button" }, []);
    const html = renderTurnSection(turnHtmlAdapter, model.process, [], true, action).disclosure.html;
    const summary = html.slice(0, html.indexOf("</summary>"));
    expect(summary).toContain('class="turn-section-actions"');
    expect(summary).toContain('class="copy-button"');
    expect(summary.indexOf("Worked for")).toBeLessThan(summary.indexOf("turn-section-actions"));
    expect(html.slice(html.indexOf("</summary>"))).not.toContain("copy-button");
  });

  function resultAdapter() {
    const literal = (text: string) => turnHtmlAdapter.element("span", {}, [text]);
    return {
      ...turnHtmlAdapter, markdown: vi.fn(literal), json: vi.fn(literal),
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
    const html = renderTurnJson(turnHtmlAdapter, text, { html: "copy" })!.html;
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
    const prose = vi.fn((text: string) => turnHtmlAdapter.element("p", {}, [text]));
    const content = renderTurnMessage({ ...turnHtmlAdapter, prose, code: prose },
      presentAgentMessage(JSON.stringify({ kind: "agent", text: "Readable answer", patch: { kind: "patch", title: "Edit", changes: [{ uri: "a", before: "b", after: "c" }] } })));
    expect(content[0]?.html).toContain("Readable answer");
    expect(content[0]?.html).not.toContain("data-diff");
    expect(content[0]?.html).not.toContain('&quot;kind&quot;');
  });
});

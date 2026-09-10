import { describe, expect, it, vi } from "vitest";
import { renderTurnResult, renderTurnSection, renderTurnMessage, turnHtmlAdapter } from "../src/turnComponents.js";
import { presentTurn } from "../src/turnPresentation.js";
import { presentAgentMessage } from "../src/agentMessagePresentation.js";

describe("shared turn rendering", () => {
  it("escapes model text and gives only Process an elapsed-time field", () => {
    const model = presentTurn({ source: '<script>alert("input")</script>', mode: "agent", durationMs: 1000 });
    const input = renderTurnSection(turnHtmlAdapter, model.input!).disclosure.html;
    expect(input).toContain('data-mode="agent"');
    expect(input).not.toContain("script");
    model.process.detail = '<img src=x onerror="alert(1)">';
    const process = renderTurnSection(turnHtmlAdapter, model.process).disclosure.html;
    expect(process).toContain("&lt;img");
    expect(process).not.toContain("<img");
    const output = renderTurnSection(turnHtmlAdapter, model.output).disclosure.html;
    expect(output).not.toContain("Worked");
    expect(output).not.toContain("button");
  });

  function resultAdapter() {
    const literal = (text: string) => turnHtmlAdapter.element("span", {}, [text]);
    return {
      ...turnHtmlAdapter, markdown: vi.fn(literal), json: vi.fn(literal),
      terminal: vi.fn((text: string, stderr: boolean) => turnHtmlAdapter.element("pre", { "data-stderr": String(stderr) }, [text])),
      patch: vi.fn((change: { uri: string }) => literal(change.uri)), plan: vi.fn(literal)
    };
  }

  it("preserves Agent patches and dispatches Plan links without granting actions to History", () => {
    const adapter = resultAdapter();
    const change = { uri: "a.ts", before: "old", after: "new" };
    renderTurnResult(adapter, { kind: "agent", text: "Answer", patch: { kind: "patch", title: "Edit", changes: [change] } });
    expect(adapter.markdown).toHaveBeenCalledWith("Answer");
    expect(adapter.patch).toHaveBeenCalledWith(change);
    renderTurnResult(adapter, { kind: "plan", text: "Plan", planPath: "plans/a.md" });
    expect(adapter.plan).toHaveBeenCalledWith("plans/a.md");
  });

  it("keeps custom and Node result payloads visible instead of dropping unknown kinds", () => {
    const adapter = resultAdapter();
    renderTurnResult(adapter, { kind: "node", value: { path: "a.ts" } });
    expect(JSON.parse(adapter.json.mock.calls[0]![0])).toEqual({ kind: "node", value: { path: "a.ts" } });
    renderTurnResult(adapter, { kind: "mcp.custom", answer: "kept" });
    expect(adapter.json).toHaveBeenLastCalledWith(JSON.stringify({ kind: "mcp.custom", answer: "kept" }, null, 2));
  });

  it("renders terminal data as text and preserves both output streams", () => {
    const adapter = resultAdapter();
    const html = renderTurnResult(adapter, { kind: "terminal", command: '<script>run()</script>', cwd: ".",
      status: "failed", exit_code: 1, stdout: "output", stderr: "error", duration_ms: 1234 }).map((node) => node.html).join("");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("exit 1");
    expect(html).not.toContain("1234");
    expect(adapter.terminal.mock.calls).toEqual([["output", false], ["error", true]]);
  });

  it("uses the same readable structured Process content for both adapters", () => {
    const prose = vi.fn((text: string) => turnHtmlAdapter.element("p", {}, [text]));
    const content = renderTurnMessage({ ...turnHtmlAdapter, prose, code: prose, patch: () => ({ html: "patch" }) },
      presentAgentMessage(JSON.stringify({ kind: "agent", text: "Readable answer", patch: { kind: "patch", title: "Edit", changes: [{ uri: "a", before: "b", after: "c" }] } })));
    expect(content[0]?.html).toContain("Readable answer");
    expect(content[0]?.html).toContain("patch");
    expect(content[0]?.html).not.toContain('&quot;kind&quot;');
  });
});

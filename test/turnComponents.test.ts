import { describe, expect, it, vi } from "vitest";
import { renderTurnResult, renderTurnSection, renderTurnMessage, renderTurnJson, terminalCommandSummary, turnHtmlAdapter } from "../src/features/conversations/presentation/turnComponents.js";
import { presentTurn } from "../src/features/conversations/presentation/turnPresentation.js";
import { presentAgentMessage } from "../src/features/conversations/presentation/agentMessagePresentation.js";

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

  it.each(['powershell -NoProfile -EncodedCommand', 'pwsh.exe -enc', '& "C:\\Program Files\\PowerShell\\pwsh.exe" -EC'])("summarizes %s without executing its payload", (prefix) => {
    const payload = Buffer.from('Write-Output "中文"', 'utf16le').toString('base64').repeat(200);
    const command = `${prefix} ${payload} -NoExit`;
    const html = renderTurnResult(resultAdapter(), { kind: "terminal", command, cwd: ".", status: "succeeded", exit_code: 0, stdout: "", stderr: "", duration_ms: 1 })[0]!.html;
    const summary = html.slice(0, html.indexOf('</summary>'));
    expect(summary).toContain('encoded command');
    expect(summary).not.toContain(payload);
    expect(html).toContain(payload);
    expect(terminalCommandSummary(command)).toContain('-NoExit');
    expect(terminalCommandSummary('npm test -- --run')).toBe('npm test -- --run');
    expect(terminalCommandSummary('echo ' + 'x'.repeat(2000))).toContain('… (expand for full command)');
  });

  it("preserves Agent patches and dispatches Plan links without granting actions to History", () => {
    const adapter = resultAdapter();
    const change = { uri: "a.ts", before: "old", after: "new" };
    renderTurnResult(adapter, { kind: "agent", text: "Answer", patch: { kind: "patch", title: "Edit", changes: [change] } });
    expect(adapter.markdown).toHaveBeenCalledWith("Answer");
    expect(adapter.patch).toHaveBeenCalledWith(change);
    renderTurnResult(adapter, { kind: "plan", text: "Plan", planPath: "plans/a.md" });
    expect(adapter.plan).toHaveBeenCalledWith("plans/a.md");
  });

  it("keeps a typed MCP payload visible instead of dropping its kind", () => {
    const adapter = resultAdapter();
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

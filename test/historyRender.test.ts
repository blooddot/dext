import { describe, expect, it } from "vitest";
import {
  conversationMarkdown,
  conversationTitle,
  highlightDext,
  highlightTerminal,
  historyTokenStyles,
  historyTurnMarkdown,
  historyTurnTitle,
  renderHistoryRecord,
  renderHistorySession
} from "../src/historyRender.js";
import type { DextHistoryRecord } from "../src/historyStore.js";

describe("Dext history rendering", () => {
  it("renders the latest answer above Process without replaying editable forms or secret answers", () => {
    const question = { id: "question-1", blocking: true, questions: [{ id: "q", header: "", question: "Which <option>?", options: [] },
      { id: "secret", header: "", question: "Secret?", options: [], isSecret: true }] };
    const html = renderHistoryRecord({ id: "turn", createdAt: 1, input: "Input", output: "Done", process: [
      { phase: "input", text: "", userInput: { ...question, status: "waiting" } },
      { phase: "input", text: "", userInput: { ...question, status: "answered", answers: { q: { answers: ["Custom <answer>"] }, secret: { answers: ["private-value"] } } } },
      { phase: "tool", text: "Tests passed" }
    ] });
    expect(html.match(/agent-input-card/g)).toHaveLength(1);
    expect(html).toContain("Which &lt;option&gt;?");
    expect(html).toContain("Custom &lt;answer&gt;");
    expect(html).not.toContain("private-value");
    expect(html).not.toContain("<form");
    expect(html.indexOf("agent-input-card")).toBeLessThan(html.indexOf("<span>Process</span>"));
  });
  it.each([undefined, "Cancelled", "Agent failed"])("hides internal Plan input with execution metadata (%s)", (error) => {
    const record: DextHistoryRecord = {
      id: "build", createdAt: 1, input: "INTERNAL_PLAN_PROMPT", process: [], output: "Finished",
      mode: "plan", executePlan: true, planPath: "plans/build.plan.md", ...(error ? { error } : {})
    };
    const html = renderHistoryRecord(record);
    expect(html).not.toContain("INTERNAL_PLAN_PROMPT");
    expect(html).not.toContain("<span>Input</span>");
    expect(html).toContain("Plan: build.plan.md");
    expect(html).toContain(`<span class="plan-status">${error ? "Failed" : "Incomplete"}</span>`);
    expect(html).toContain(error ?? "Finished");
  });

  it.each([
    ["agent", "Agent"], ["ask", "Ask"], ["plan", "Plan"], ["code", "Code"], [undefined, "Unknown"]
  ] as const)("shows the recorded input mode %s without changing the copied prompt", (mode, label) => {
    const turn: DextHistoryRecord = { id: "turn", createdAt: 1, input: "prompt", output: "answer", process: [], ...(mode ? { mode } : {}) };
    const html = renderHistoryRecord(turn, "session");
    expect(html).toContain(`<span>Input</span><span class="turn-mode" data-mode="${mode ?? "unknown"}"`);
    expect(html).toContain(`>${label}</span>`);
    if (!mode) expect(html).toContain("Mode was not recorded for this turn");
    expect(historyTurnMarkdown(turn)).toContain("### Input\n\nprompt");
  });

  it("provides turn actions with both identifiers, including in lazily loaded session bodies", () => {
    const turn: DextHistoryRecord = { id: "turn-2", createdAt: 2, input: "question", output: "answer", process: [] };
    const html = renderHistoryRecord(turn, "session-1");
    const summary = html.slice(0, html.indexOf("</summary>"));
    const actions = [...summary.matchAll(/<button[^>]*data-history-command="([^"]+)"[^>]*>/g)];
    expect(actions.map((match) => match[1])).toEqual([
      "dext.history.renameTurn",
      "dext.history.forkFromTurn", "dext.history.copyTurn", "dext.history.deleteTurn"
    ]);
    for (const [button] of actions) {
      expect(button).toContain('data-session-id="session-1"');
      expect(button).toContain('data-turn-id="turn-2"');
    }
    expect(summary).toMatch(/data-history-command="dext.history.renameTurn"[^>]*title="Rename turn"[^>]*><i class="codicon codicon-rename"/);
    expect(renderHistoryRecord(turn)).not.toContain("data-history-command");
    const sessionHtml = renderHistorySession({ id: "session-1", createdAt: 2, updatedAt: 2, turns: [turn] });
    const sessionSummary = sessionHtml.slice(0, sessionHtml.indexOf("</summary>"));
    expect([...sessionSummary.matchAll(/data-history-command="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "dext.history.continueConversation", "dext.history.renameConversation", "dext.history.forkConversation",
      "dext.history.copyConversation", "dext.history.addFavorite", "dext.history.archiveConversation", "dext.history.deleteConversation"
    ]);
  });

  it("renders an escaped custom turn title without renaming the parent or changing the copied input", () => {
    const turn: DextHistoryRecord = { id: "turn-1", title: '<New & "name">', createdAt: 1, input: "original question", output: "answer", process: [] };
    const html = renderHistorySession({ id: "session-1", createdAt: 1, updatedAt: 1, turns: [turn] });
    expect(html).toContain('class="history-summary-input named">&lt;New &amp; &quot;name&quot;&gt;</span>');
    expect(html.slice(0, html.indexOf("</summary>"))).toContain("original question");
    expect(historyTurnTitle(turn)).toBe(turn.title);
    expect(historyTurnTitle({ ...turn, title: "" })).toBe("original question");
    expect(historyTurnMarkdown(turn, 2)).toContain("## Turn 3");
    expect(historyTurnMarkdown(turn)).toContain("### Input\n\noriginal question");
    expect(historyTurnMarkdown(turn)).toContain("### Output\n\nanswer");
  });

  it("uses Python token classes for Dext input", () => {
    const html = highlightDext('result = code.edit(target=ref.selection, instruction="fix")');
    expect(html).toContain("tok-variableName");
    expect(html).toContain("tok-string");
    expect(historyTokenStyles({ string: "#123456" })).toContain("#123456");
  });

  it("renders ANSI terminal colors and strips cursor control sequences", () => {
    const red = String.fromCharCode(27) + "[31mred" + String.fromCharCode(27) + "[0m";
    const html = highlightTerminal(`before\r${red}\nnext`);
    expect(html).toContain('<span class="ansi-red">red</span>');
    // A carriage return rewrites the current terminal line, so the prefix is
    // replaced by the colored output.
    expect(html).not.toContain("before");
    expect(html).toContain("next");
    expect(html).not.toContain(String.fromCharCode(27));
  });

  it("adds fallback emphasis when a non-TTY command emits plain output", () => {
    const html = highlightTerminal("RUN v4.1.10\nTest Files  1 passed (1)\nerror: failed");
    expect(html).toContain('<span class="ansi-bright-blue">RUN v4.1.10</span>');
    expect(html).toContain('<span class="ansi-green">Test Files  1 passed (1)</span>');
    expect(html).toContain('<span class="ansi-red">error: failed</span>');
  });

  it("keeps terminal stderr separate and highlighted in history output", () => {
    const record: DextHistoryRecord = {
      id: "terminal-ansi",
      createdAt: 1,
      input: "terminal(command=\"npm test\")",
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "terminal", source: "code", arguments: [] },
          method: { id: "terminal", title: "Terminal", kind: "command", source: "builtin" },
          result: { kind: "terminal", command: "npm test", cwd: ".", stdout: "\u001b[32mok\u001b[0m", stderr: "failed", status: "failed", exit_code: 1, duration_ms: 1 },
          durationMs: 1
        }]
      }
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain('<span class="ansi-green">ok</span>');
    expect(html).toContain('class="terminal-text terminal-stderr"');
  });

  it("renders structured output instead of a raw workflow JSON block", () => {
    const record: DextHistoryRecord = {
      id: "1",
      createdAt: 1,
      input: 'ask(input="hello")',
      process: [{ phase: "reasoning", text: "Consider context" }],
      output: JSON.stringify({ kind: "workflow" }),
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "ask", source: "code", arguments: [] },
          method: { id: "ask", title: "Ask", kind: "command", source: "builtin" },
          result: { kind: "ask", text: "hello" },
          durationMs: 10
        }]
      }
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain("history-execution");
    expect(html).toContain("Consider context");
    expect(html).toContain("hello");
    expect(html).not.toContain('&quot;kind&quot;: &quot;workflow&quot;');
  });

  it("keeps elapsed time in Process and leaves Output to its result body", () => {
    const record: DextHistoryRecord = {
      id: "timing", createdAt: 1, input: "ask(input=\"hello\")", process: [], output: "",
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "ask", source: "code", arguments: [] },
          method: { id: "ask", title: "Ask", kind: "command", source: "builtin" },
          result: { kind: "ask", text: "hello" }, durationMs: 1_234
        }]
      }
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain('Worked for 1s234ms');
    const output = html.slice(html.indexOf('data-turn-section="output"'));
    expect(output).not.toContain("1s234ms");
    expect(output.slice(0, output.indexOf("</summary>"))).not.toContain("button");
    expect(output.match(/data-copy="hello"/g)).toHaveLength(1);
  });

  it("recovers structured data from legacy JSON history records", () => {
    const record: DextHistoryRecord = {
      id: "legacy",
      createdAt: 1,
      input: 'print(text="old")',
      process: [],
      output: JSON.stringify({
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "print", source: "code", arguments: [] },
          method: { id: "print", title: "Print", kind: "command", source: "builtin" },
          result: { kind: "print", text: "old" },
          durationMs: 2
        }]
      })
    };
    expect(renderHistoryRecord(record)).toContain("old");
  });

  it("places a turn timestamp after its summary content", () => {
    const record: DextHistoryRecord = {
      id: "timestamp-order",
      createdAt: 1,
      input: 'ask(input="hello")',
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
    expect(summary.indexOf('class="history-summary-input"')).toBeLessThan(summary.indexOf("history-record-time"));
  });

  it("renders UI results so selections and confirmations are visible in history", () => {
    const record: DextHistoryRecord = {
      id: "ui-result",
      createdAt: 1,
      input: 'choice = ui.radio(label="Pick", options=["one", "two"])',
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [
          {
            invocation: { kind: "invocation", method: "ui.radio", source: "code", arguments: [] },
            method: { id: "ui.radio", title: "Radio", kind: "command", source: "builtin" },
            result: { kind: "ui", type: "radio", selected: ["two"] },
            durationMs: 1
          },
          {
            invocation: { kind: "invocation", method: "ui.confirm", source: "code", arguments: [] },
            method: { id: "ui.confirm", title: "Confirm", kind: "command", source: "builtin" },
            result: { kind: "ui", type: "confirm", confirmed: false },
            durationMs: 1
          }
        ]
      }
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain("two");
    expect(html).toContain("Cancelled");
  });

  it("renders Codex progress messages inline in the process timeline", () => {
    const record: DextHistoryRecord = {
      id: "progress",
      createdAt: 1,
      input: "code.explain(target=ref.selection)",
      process: [{ phase: "message", text: "I will inspect the selected implementation first." }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain('class="process-message agent-stream-item agent-trace-message"');
    expect(html).toContain("I will inspect the selected implementation first.");
  });

  it("uses Markdown paragraph and line-break rules for history Process messages", () => {
    const record: DextHistoryRecord = {
      id: "process-markdown-breaks",
      createdAt: 1,
      input: "agent(input=\"summarize\")",
      process: [{ phase: "message", text: "First line\nsecond line\n\n- one\n- two" }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain('class="agent-stream-text"><div class="markdown-body"');
    expect(html).toContain("<p>First line<br>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
  });

  it("keeps agent dialogue and expandable command details in the same process timeline", () => {
    const record: DextHistoryRecord = {
      id: "work-log",
      createdAt: 1,
      input: 'agent(input="Inspect this")',
      process: [
        { phase: "message", group: "work-log", text: "Inspecting the workspace" },
        { phase: "tool", group: "work-log", title: "git status", text: "git status" }
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("Inspecting the workspace");
    expect(html).toContain("git status");
    expect(html).not.toContain("Ran 1 command");
    expect(html).toContain('class="process-message agent-stream-item agent-trace-message"');
    expect(html).toMatch(/class="history-disclosure process-event(?: process-command-group)?"/);
  });

  it("groups consecutive commands without moving them across process messages", () => {
    const record: DextHistoryRecord = {
      id: "grouped-process-commands",
      createdAt: 1,
      input: 'agent(input="update greeting")',
      process: [
        { phase: "reasoning", text: "Inspect the current implementation" },
        { phase: "tool", title: "rg greeting", text: "rg greeting" },
        { phase: "tool", title: "Get-Content greeting.ts", text: "Get-Content greeting.ts" },
        { phase: "message", text: "Apply the smallest change" },
        { phase: "tool", title: "npm test", text: "npm test" }
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("Ran 2 commands");
    expect(html).toContain('class="history-disclosure process-event process-command-group"');
    expect(html.indexOf("Inspect the current implementation")).toBeLessThan(html.indexOf("Ran 2 commands"));
    expect(html.indexOf("Ran 2 commands")).toBeLessThan(html.indexOf("Apply the smallest change"));
    expect(html.indexOf("Apply the smallest change")).toBeLessThan(html.indexOf("npm test"));
  });

  it("reproduces the step grouping an agent reported instead of regrouping by arrival", () => {
    const grouped = (groupId: string, title: string) => ({
      phase: "tool" as const,
      group: "work-log" as const,
      groupId,
      groupLabel: groupId === "g0" ? "运行了 2 条命令" : "已编辑 1 个文件 · 运行了 1 条命令",
      toolKind: "command" as const,
      title,
      text: title
    });
    const record: DextHistoryRecord = {
      id: "reported-groups",
      createdAt: 1,
      input: 'agent(input="fix layout")',
      process: [
        { phase: "message", group: "work-log", text: "Locating the selector" },
        grouped("g0", "rg selector"),
        grouped("g0", "rg fallback"),
        { phase: "tool", group: "work-log", toolKind: "image", solo: true, title: "已查看 shot.png", text: "已查看 shot.png" },
        { phase: "message", group: "work-log", text: "Applying the fix" },
        grouped("g1", "npm test")
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("运行了 2 条命令");
    expect(html).toContain("已编辑 1 个文件 · 运行了 1 条命令");
    expect(html).not.toContain("Ran 2 commands");
    // The standalone step keeps its own row rather than joining a group.
    expect(html).toContain('class="history-disclosure process-event process-command-solo"');
    expect(html.indexOf("运行了 2 条命令")).toBeLessThan(html.indexOf("已查看 shot.png"));
    expect(html.indexOf("已查看 shot.png")).toBeLessThan(html.indexOf("Applying the fix"));
    expect(html.indexOf("Applying the fix")).toBeLessThan(html.indexOf("npm test"));
  });

  it("preserves the arrival order of thoughts and commands", () => {
    const record: DextHistoryRecord = {
      id: "interleaved-process",
      createdAt: 1,
      input: 'agent(input="update greeting")',
      process: [
        { phase: "reasoning", text: "Inspect the current implementation" },
        { phase: "tool", title: "rg greeting", text: "rg greeting" },
        { phase: "message", text: "Apply the smallest change" }
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html.indexOf("Inspect the current implementation")).toBeLessThan(html.indexOf("rg greeting"));
    expect(html.indexOf("rg greeting")).toBeLessThan(html.indexOf("Apply the smallest change"));
  });

  it("keeps patch details and both diff layouts in structured thoughts", () => {
    const structured = JSON.stringify({
      kind: "patch",
      title: "Complete hello_world",
      changes: [{
        uri: "target-1/temp.py",
        before: "def hello_world():\n    pass",
        after: 'def hello_world():\n    return "hello world"'
      }]
    });
    const record: DextHistoryRecord = {
      id: "structured-patch",
      createdAt: 1,
      input: "agent(input=\"complete it\", apply=False)",
      process: [{ phase: "message", text: structured }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("target-1/temp.py");
    expect(html).toContain("def hello_world():");
    expect(html).toContain('return &quot;hello world&quot;');
    expect(html).toContain('data-diff-mode="inline"');
    expect(html).toContain('data-diff-mode="split"');
    expect(html).toContain("diff-inline");
    expect(html).toContain("diff-split");
  });

  it("renders an agent result patch as an expandable diff in history", () => {
    const record: DextHistoryRecord = {
      id: "agent-patch",
      createdAt: 1,
      input: "agent(input=\"update greeting\")",
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "agent", source: "code", arguments: [] },
          method: { id: "agent", title: "Agent", kind: "command", source: "builtin" },
          result: {
            kind: "agent",
            text: "Applied the change.",
            patch: {
              kind: "patch",
              title: "Update greeting",
              changes: [{ uri: "file:///workspace/greeting.ts", before: "export const greeting = 'hi';", after: "export const greeting = 'hello';" }]
            }
          },
          durationMs: 10
        }]
      }
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("greeting.ts");
    expect(html).toContain("data-diff-mode=\"split\"");
    expect(html).toContain("export const greeting");
  });

  it("uses compact durations in history summaries and executions", () => {
    const record: DextHistoryRecord = {
      id: "duration",
      createdAt: 1,
      input: 'ask(input="hello")',
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "ask", source: "code", arguments: [] },
          method: { id: "ask", title: "Ask", kind: "command", source: "builtin" },
          result: { kind: "ask", text: "hello" },
          durationMs: 40_499
        }]
      }
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("40s499ms");
    expect(html).not.toContain("40499 ms");
  });

  it("renders readable @ reference tokens as Chips while retaining raw copy source", () => {
    const token = "@src/pathx.py#L55,1-L66,32";
    const record: DextHistoryRecord = {
      id: "reference",
      createdAt: 1,
      input: 'agent(input="Explain ' + token + '")',
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("history-file-reference");
    expect(html).toContain("pathx.py 55-66");
    expect(html).toContain(token);
  });

  it("does not syntax-highlight conversational prose in history input", () => {
    const attachment = "@.dext-global/attachments/0123456789abcdef01234567.png";
    const record: DextHistoryRecord = {
      id: "plain-prose",
      createdAt: 1,
      input: `${attachment} 还有Build按钮要不要改成plan的主题色（深金色）?`,
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("还有Build按钮要不要改成plan的主题色");
    expect(html).toContain("history-file-reference");
    expect(html).not.toContain("tok-variableName");
    expect(html).not.toContain("tok-keyword");
  });

  it("syntax-highlights code-mode Input in rendered history", () => {
    const record: DextHistoryRecord = {
      id: "highlighted-input",
      createdAt: 1,
      input: 'ui.select(label="Pick", options=["one", "two"], multiple=True)',
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain('class="tok-propertyName"');
    expect(html).toContain('class="tok-string"');
    expect(html).toContain('class="tok-bool"');
  });

  it("highlights Dext call names and keyword arguments distinctly", () => {
    const html = highlightDext('ask(input="https://example.test")');
    expect(html).toContain('<span class="tok-function">ask</span>');
    expect(html).toContain('<span class="tok-propertyName">input</span>');
  });

  it("renders image attachments as ordinary file reference Chips", () => {
    const path = ".dext/attachments/0123456789abcdef01234567.png";
    const record: DextHistoryRecord = {
      id: "image-reference",
      createdAt: 1,
      input: `ask(input="Inspect @${path}")`,
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("data-open-file-reference");
    expect(html).toContain("0123456789abcdef01234567.png");
    expect(html).not.toContain("data-open-image-attachment");
  });

  it("renders trailing-slash directory references as folder Chips", () => {
    const record: DextHistoryRecord = {
      id: "directory-reference",
      createdAt: 1,
      input: 'ask(input="Inspect @src/components/")',
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("history-file-reference");
    expect(html).toContain("codicon-folder");
    expect(html).toContain("components");
    expect(html).not.toContain("data-open-file-reference");
  });

  it("renders source separators around file reference Chips", () => {
    const record: DextHistoryRecord = {
      id: "inline-reference",
      createdAt: 1,
      input: 'ask(input="before @src/a.ts after")',
      process: [],
      output: ""
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain("before <span class=\"attachment-chip");
    expect(html).toContain("</span> after");
  });

  it("groups continuous turns under one collapsible conversation", () => {
    const turns: DextHistoryRecord[] = ["first", "second"].map((text, index) => ({
      id: String(index),
      createdAt: index + 1,
      input: `ask(input="${text}")`,
      process: [],
      output: ""
    }));

    const html = renderHistorySession({ id: "session", createdAt: 1, updatedAt: 2, turns });

    expect(html).toContain('class="history-session"');
    expect(html.match(/class="history-record"/g)).toHaveLength(2);
    expect(html).toContain("2 turns");
    const summary = html.slice(0, html.indexOf("history-session-body"));
    expect(summary).toMatch(/history-summary-input[^>]*>ask\(input=&quot;first&quot;\)<\/span><span class="history-meta">2 turns<\/span><span class="history-meta history-session-time">/);
  });

  it("tags conversations and turns so the native context menu knows its target", () => {
    const turns: DextHistoryRecord[] = ["first", "second"].map((text, index) => ({
      id: `turn-${index}`,
      createdAt: index + 1,
      input: `ask(input="${text}")`,
      process: [],
      output: ""
    }));

    const html = renderHistorySession({ id: "session-1", createdAt: 1, updatedAt: 2, turns });

    expect(html).toContain('data-vscode-context=\'{&quot;webviewSection&quot;:&quot;session&quot;,&quot;sessionId&quot;:&quot;session-1&quot;,&quot;dextFavorite&quot;:false,&quot;preventDefaultContextMenuItems&quot;:true}\'');
    expect(html).toContain('&quot;webviewSection&quot;:&quot;turn&quot;,&quot;sessionId&quot;:&quot;session-1&quot;,&quot;turnId&quot;:&quot;turn-0&quot;');
    // A turn rendered on its own has no conversation to act on.
    expect(renderHistoryRecord(turns[0]!)).not.toContain("data-vscode-context");
  });

  it("marks a favorite conversation for both the reader and the context menu", () => {
    const session = {
      id: "session-1",
      createdAt: 1,
      updatedAt: 2,
      turns: [{ id: "turn-0", createdAt: 1, input: 'ask(input="first")', process: [], output: "" }]
    };

    const html = renderHistorySession(session, { favorite: true });

    expect(html).toContain('class="history-session favorite"');
    expect(html).toContain("codicon-star-full");
    expect(html).toContain("&quot;dextFavorite&quot;:true");
    // A turn inherits the conversation's favorite state from its parent element.
    expect(html.match(/dextFavorite/g)).toHaveLength(1);
  });

  it("names a conversation after its first message until it is renamed", () => {
    const session = {
      id: "session-1",
      createdAt: 1,
      updatedAt: 2,
      turns: [{
        id: "turn-0",
        createdAt: 1,
        input: 'agent(input="Explain @src/a.ts\nand then stop")',
        process: [],
        output: ""
      }]
    };

    // A reference is spelled out the compact way it reads in the UI.
    expect(conversationTitle(session)).toBe('agent(input="Explain a.ts');
    expect(conversationTitle({ ...session, turns: [] })).toBe("New conversation");
    expect(renderHistorySession(session)).toContain('agent(input=&quot;Explain a.ts');

    const renamed = renderHistorySession(session, { name: "Auth refactor" });
    const summary = renamed.slice(0, renamed.indexOf("history-session-body"));
    expect(summary).toContain('class="history-summary-input named">Auth refactor<');
    // The chosen name replaces the first message in the conversation header,
    // while the turn below still shows what was actually asked.
    expect(summary).not.toContain("Explain a.ts");
    expect(renamed).toContain("Explain a.ts");
  });

  it("copies a conversation as Markdown with one section per turn", () => {
    const turns: DextHistoryRecord[] = [
      {
        id: "turn-0",
        createdAt: 1,
        input: 'ask(input="explain")',
        process: [],
        output: "",
        response: { kind: "workflow", executions: [] }
      },
      { id: "turn-1", createdAt: 2, input: 'ask(input="retry")', process: [], output: "", error: "cancelled" }
    ];

    const markdown = conversationMarkdown({ id: "session-1", createdAt: 1, updatedAt: 2, turns });

    expect(markdown).toContain("# Dext conversation");
    expect(markdown).toContain("## Turn 1");
    expect(markdown).toContain('ask(input="explain")');
    expect(markdown).toContain("### Error");
    expect(markdown).toContain("cancelled");
  });
});

it("renders unknown historical UI results as bounded escaped JSON without an executable card", () => {
  const output = JSON.stringify({ kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "ui.choose", source: "code", arguments: [] },
    method: { id: "ui.choose", title: "Old interaction", source: "builtin", kind: "command" },
    result: { kind: "ui", type: "choice", selected: ["<img src=x onerror=alert(1)>", "x".repeat(30000)] }, durationMs: 1
  }] });
  const html = renderHistoryRecord({ id: "old", createdAt: 1, input: "Old workflow", process: [], output });
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<form");
  expect(html).not.toContain('type="radio"');
  expect(html).not.toContain("x".repeat(21000));
});

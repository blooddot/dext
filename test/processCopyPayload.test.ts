import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Replaying a stored turn renders one event per call, so building the whole
// Process copy timeline each time made opening a long turn quadratic in it.
const main = readFileSync("src/webview/main.ts", "utf8");
const renderer = ts.transpileModule(
  main.slice(main.indexOf("function renderAgentEvent("), main.indexOf("function resetAgentTrace(")),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

describe("Process copy payload", () => {
  it("is read when the reader asks for it, not once per replayed event", () => {
    const copyText = vi.fn(() => "whole timeline");
    const setProcessCopy = vi.fn<(read: () => string, hasText: boolean) => void>();
    const context = {
      trace: { renderEvent: vi.fn(), copyText, hasCopyText: () => true },
      transcript: { active: { setProcessCopy } },
      agentTokenUsage: undefined, agentProgressState: "Thinking",
      updateAgentProgress: vi.fn(), updateTurnTokenUsage: vi.fn()
    };
    runInNewContext(`${renderer}
      for (let index = 0; index < 500; index += 1) renderAgentEvent({ phase: "tool", text: "line " + index });
    `, context);
    expect(copyText).not.toHaveBeenCalled();
    expect(setProcessCopy).toHaveBeenCalledTimes(500);
    const [read] = setProcessCopy.mock.calls.at(-1)!;
    expect(read()).toBe("whole timeline");
    expect(copyText).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from "vitest";
import { NO_STATED_REASON, turnChanges } from "../src/features/conversations/domain/turnDiff.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";
import type { InputExecutionResponse } from "../src/shared/contracts/types.js";

function record(changedFiles?: string[], process: DextHistoryRecord["process"] = [], response?: InputExecutionResponse): DextHistoryRecord {
  return { id: "turn", createdAt: 1, input: "do it", process, output: "", ...(changedFiles ? { changedFiles } : {}), ...(response ? { response } : {}) };
}

function answer(text: string): InputExecutionResponse {
  return { kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "agent", arguments: [{ name: "input", value: "do it" }], source: "chat" },
    method: { id: "agent", title: "Agent", kind: "command", source: "builtin" },
    result: { kind: "agent", text },
    durationMs: 1
  }] };
}

describe("turnChanges", () => {
  it("takes the tool event line that names the whole path", () => {
    const changes = turnChanges(record(["src/app/sidebarProvider.ts"], [
      { phase: "status", text: "src/app/sidebarProvider.ts is unrelated status" },
      { phase: "tool", text: "apply patch to src/features/a.ts\nwrite src/app/sidebarProvider.ts" }
    ]));
    expect(changes).toEqual([{ path: "src/app/sidebarProvider.ts", reason: "write src/app/sidebarProvider.ts" }]);
  });

  it("falls back to the Agent's own sentence naming only the file", () => {
    const changes = turnChanges(record(["src/features/conversations/domain/turnDiff.ts"], [],
      answer("I added the reason column in turnDiff.ts so the diff can label each file.")));
    expect(changes).toEqual([{ path: "src/features/conversations/domain/turnDiff.ts", reason: "I added the reason column in turnDiff.ts so the diff can label each file." }]);
  });

  it("marks a file the turn never mentioned instead of reusing another file's line", () => {
    const changes = turnChanges(record(["src/a.ts", "src/features/b/render.ts"], [
      { phase: "tool", text: "edit src/features/b/render.ts to add the button" }
    ]));
    expect(changes).toEqual([
      { path: "src/a.ts", reason: NO_STATED_REASON },
      { path: "src/features/b/render.ts", reason: "edit src/features/b/render.ts to add the button" }
    ]);
    expect(NO_STATED_REASON).toBe("no stated reason");
  });

  it("returns nothing when the turn recorded no changed files", () => {
    expect(turnChanges(record(undefined, [{ phase: "tool", text: "edit src/a.ts" }]))).toEqual([]);
    expect(turnChanges(record([], [{ phase: "tool", text: "edit src/a.ts" }]))).toEqual([]);
  });

  it("takes the description out of the turn's own table row, not the row syntax", () => {
    const changes = turnChanges(record(["docs/workflows.md"], [],
      answer("| File | Change | Detail |\n| --- | --- | --- |\n| `docs/workflows.md` | 加一句表格说明 | 中英同序 |")));
    expect(changes).toEqual([{ path: "docs/workflows.md", reason: "加一句表格说明 — 中英同序" }]);
  });

  it("drops the bullet and the path when the line starts with the file", () => {
    const changes = turnChanges(record(["media/styles.css"], [],
      answer("- **media/styles.css**: 恢复表格样式，路径用链接色")));
    expect(changes).toEqual([{ path: "media/styles.css", reason: "恢复表格样式，路径用链接色" }]);
  });

  it("prefers what the Agent said over a tool event that only names the file", () => {
    const changes = turnChanges(record(["src/a.ts"],
      [{ phase: "tool", text: "Successfully replaced 1 block(s) in src/a.ts." }],
      answer("| `src/a.ts` | 加了原因列 | 中英同序 |")));
    expect(changes).toEqual([{ path: "src/a.ts", reason: "加了原因列 — 中英同序" }]);
  });

  it("takes the Agent's per-file section, its heading plus the bullets under it", () => {
    const text = [
      "## 改动",
      "**`src/webview/referenceField.ts`**",
      "- 新增 Ctrl/Cmd+Shift+V：插入剪贴板原文，不再还原成引用 Chip。",
      "- 普通 Ctrl/Cmd+V 改为复用 Input 的 `codeReferencePasteText`。",
      "",
      "**`scripts/checkInteractionUi.mjs`**",
      "- 在真实浏览器检查里新增断言。"
    ].join("\n");
    expect(turnChanges(record(["src/webview/referenceField.ts"], [], answer(text)))).toEqual([{
      path: "src/webview/referenceField.ts",
      reason: "新增 Ctrl/Cmd+Shift+V：插入剪贴板原文，不再还原成引用 Chip。 · 普通 Ctrl/Cmd+V 改为复用 Input 的 `codeReferencePasteText`。"
    }]);
  });

  it("gives both files of a shared heading the same bullets", () => {
    const text = ["**`docs/workflows.md` / `docs/workflows.zh-CN.md`**", "- 在表单字段说明中补充粘贴行为。"].join("\n");
    const changes = turnChanges(record(["docs/workflows.md", "docs/workflows.zh-CN.md"], [], answer(text)));
    expect(changes.map((change) => change.reason)).toEqual([
      "在表单字段说明中补充粘贴行为。",
      "在表单字段说明中补充粘贴行为。"
    ]);
  });

  it("ignores a fenced block that merely contains the file", () => {
    const text = ["```ts", "31: import { ClipboardClient } from \"./clipboardClient.js\";", "src/webview/main.ts", "```", "Done."].join("\n");
    expect(turnChanges(record(["src/webview/main.ts"], [], answer(text)))).toEqual([
      { path: "src/webview/main.ts", reason: NO_STATED_REASON }
    ]);
  });

  it("keeps a section of many bullets short", () => {
    const text = ["**`src/a.ts`**", `- ${"甲".repeat(150)}`, `- ${"乙".repeat(150)}`].join("\n");
    const [change] = turnChanges(record(["src/a.ts"], [], answer(text)));
    // The second bullet would push the cell past the limit, so it is dropped whole.
    expect(change?.reason).toBe(`${"甲".repeat(150)}...`);
  });

  it("keeps a long command line short", () => {
    const long = `npm run ${"x".repeat(200)} && edit src/a.ts`;
    const [change] = turnChanges(record(["src/a.ts"], [{ phase: "tool", text: long }]));
    expect(change?.reason).toBe(`${long.slice(0, 140)}...`);
  });
});


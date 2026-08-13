# Dext

Dext is a typed AI workflow editor for Visual Studio Code. Workflows use a deliberately small Python syntax, but Dext parses them as data and never starts or embeds a Python interpreter.

Without an Agent profile, Dext validates workflow structure, resolves immutable code references, and produces typed deterministic result previews. When a Codex or Claude CLI profile is selected, the same typed API contract is sent to that CLI and its structured output is validated before display.

## Workflow language

Natural language must be explicit through `chat(...)`; arbitrary text is a compile error.

```python
analysis = chat(
    message="""Explain this implementation and give refactoring requirements.""",
    context=[ref.selection],
)

edit = code.edit(
    target=[ref.selection],
    instruction=analysis.text,
)

review = code.review(
    target=edit.files,
    instruction=edit.summary,
)

if review.status == "pass":
    applied = code.apply(result=edit)
```

The input workflow language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, and `if`/`else` with `==` or `!=`. `.dx` API files additionally support one typed `main()` function and explicit imports. User functions/classes, loops, reassignment, `eval`, `exec`, and system/file/network APIs are rejected. Execution is sequential; unselected and downstream steps are reported as `skipped`.

## Built-in API

- `chat(...) -> ChatResult`
- `code.explain(...) -> ExplainResult`
- `code.edit(...) -> EditResult`
- `code.review(...) -> ReviewResult`
- `code.apply(...) -> ApplyResult`
- `terminal.run(command, cwd=".", timeout_ms=120000) -> TerminalResult`
- `print(text, label?) -> PrintResult`

Every API output implements the shared `Result` contract. `code.review` and `code.explain` accept either code context or any prior `Result`; `code.apply(result=...)` accepts a `Result` and applies it when that result contains a patch. Agent CLIs receive prior results as versioned `dext-result` JSON envelopes instead of interpolated strings. Result variables and fields such as `edit_result: EditResult` and `edit_result.patch: PatchResult` are available to completion and hover. `ReviewStatus` is the string union `"pass" | "warning" | "fail"`.

`terminal.run` is available only in a trusted local `file` workspace. Its `cwd` must stay inside the workspace, every command requires a VS Code modal confirmation, the timeout is capped at 10 minutes, and captured output is bounded. It returns `TerminalStatus = "succeeded" | "failed" | "timed_out"`; a nonzero exit code is a typed failed result, while rejecting the confirmation cancels that workflow step and skips downstream steps.

`print` renders its typed text result only in Dext Output and never writes to the integrated terminal.

Context values are `ref.selection`, `ref.active_file`, `ref.file("path")`, and `ref.symbol("name")`:

- `ref.selection` resolves the current selection in the active editor.
- `ref.active_file` resolves the complete active editor file.
- `ref.file("path")` resolves a workspace file or an optional line/column range.
- `ref.symbol("name")` asks VS Code's workspace symbol provider for a declaration and its source range.

Copying a VS Code selection, choosing a file, or dropping one into Dext inserts an atomic `ref.file("path#Lstart,column-Lend,column")` chip. The chip can be removed atomically, participates in undo/redo, and opens the referenced file and range when clicked.

The editor uses CodeMirror's Python grammar for syntax highlighting, indentation, bracket matching, and native editor behavior. Dext adds API completion, keyword and result-field completion, signature help, hover documentation, exact compiler diagnostics, and a lint gutter.

## Method configuration

Custom APIs live in `.dext/api/**/*.dx`. Directory segments become namespaces and each file exports one API through `main()`.

```python
# .dext/api/team/review.dx -> team.review
from common import explain

def main(target: Context) -> ReviewResult:
    analysis = explain(target=target)
    return code.review(target=target, instruction=analysis.text)
```

`.dx` uses a restricted Python-like syntax. It is parsed by Dext and never starts a Python interpreter. Imports are explicit and only refer to other `.dext/api` files; external files are not read until VS Code marks the workspace as trusted.

Agent profiles are stored in VS Code extension global storage. The Run row exposes Agent, Model, Reasoning, and Speed selectors. Codex profiles read the local Codex model cache when available, including supported reasoning levels and speed tiers, and pass the selected values to the CLI. A `.dx` file may override the Agent and Model with `@api(agent="codex", model="...")`; otherwise the Run selection is used. `Dext: Configure Agent CLI` edits executable commands and custom model labels without handling credentials.

Built-in APIs are always available. Custom APIs are scoped by explicit `import` or `from ... import ...` statements; completion, hover, signatures, and compilation use the same import scope.

## Architecture

- `src/core/workflow.ts`: Lezer Python parser traversal, restricted AST, semantic types, and exact diagnostics.
- `src/core/workflowRuntime.ts`: sequential result composition and branch/step state.
- `src/core/languageService.ts`: Dext completions, hover, signatures, and diagnostics.
- `src/core/contextResolver.ts`: immutable context snapshots.
- `src/core/axAdapter.ts`: Ax/Zod/JSON Schema contract boundary.
- `src/core/runtime.ts`: deterministic executor allowlist.
- `src/core/customApi.ts`: `.dext/api` loader, imports, signatures, and custom plans.
- `src/core/agentRunner.ts`: structured Codex/Claude CLI adapter boundary.
- `src/webview/codeEditor.ts`: CodeMirror Python language integration.

## Development

Requirements: Node.js 20 or newer and VS Code 1.105 or newer.

```bash
npm install
npm run check
```

Run `npm run test:host` for the VS Code activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` for a nonstandard VS Code installation or `DEXT_TEST_DOWNLOAD=1` for an isolated downloaded build.

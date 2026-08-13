# Dext

Dext is a typed AI workflow editor for Visual Studio Code. Workflows use a deliberately small Python syntax, but Dext parses them as data and never starts or embeds a Python interpreter.

This first version is offline and deterministic. It validates workflow structure, resolves immutable code references, and produces typed result previews. It does not contact a model or write workspace files.

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
    applied = code.apply(patch=edit.patch)
```

The restricted language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, and `if`/`else` with `==` or `!=`. Imports, user functions/classes, loops, arbitrary calls, reassignment, `eval`, `exec`, and system/file/network APIs are rejected. Execution is sequential; unselected and downstream steps are reported as `skipped`.

## Built-in API

- `chat(...) -> ChatResult`
- `code.explain(...) -> ExplainResult`
- `code.edit(...) -> EditResult`
- `code.review(...) -> ReviewResult`
- `code.apply(...) -> ApplyResult`
- `terminal.run(command, cwd=".", timeout_ms=120000) -> TerminalResult`
- `print(text, label?) -> PrintResult`

Results are fixed, typed, and composable. For example, `ChatResult.text`, `EditResult.patch`, `EditResult.files`, and `ReviewResult.status` can feed later steps. `ReviewStatus` is the string union `"pass" | "warning" | "fail"`.

`terminal.run` is available only in a trusted local `file` workspace. Its `cwd` must stay inside the workspace, every command requires a VS Code modal confirmation, the timeout is capped at 10 minutes, and captured output is bounded. It returns `TerminalStatus = "succeeded" | "failed" | "timed_out"`; a nonzero exit code is a typed failed result, while rejecting the confirmation cancels that workflow step and skips downstream steps.

`print` renders its typed text result only in Dext Output and never writes to the integrated terminal.

Context values are `ref.selection`, `ref.active_file`, `ref.file("path")`, and `ref.symbol("name")`. Copying a VS Code selection, choosing a file, or dropping one into Dext inserts an atomic `ref.file("path#Lstart,column-Lend,column")` chip. The chip can be removed atomically, participates in undo/redo, and opens the referenced file and range when clicked.

The editor uses CodeMirror's Python grammar for syntax highlighting, indentation, bracket matching, and native editor behavior. Dext adds API completion, keyword and result-field completion, signature help, hover documentation, exact compiler diagnostics, and a lint gutter.

## Method configuration

Project methods live in `.dext/methods.json`; a trusted global file can be selected with `dext.globalMethodsFile`. IDs use Python-compatible dotted identifiers and appear as callable workflow APIs.

```json
{
  "version": 1,
  "methods": [
    {
      "id": "project.task.plan",
      "title": "Plan Project Task",
      "description": "Build a deterministic plan preview.",
      "kind": "command",
      "version": "1.0.0",
      "input": [
        { "name": "goal", "type": "string", "required": true }
      ],
      "output": { "kind": "plan" },
      "executor": { "kind": "deterministic", "handler": "outlinePlan" }
    }
  ]
}
```

Configuration cannot contain JavaScript, Python, or shell code. External files are not read until VS Code marks the workspace as trusted, and `ref.file` cannot escape the workspace root.

## Architecture

- `src/core/workflow.ts`: Lezer Python parser traversal, restricted AST, semantic types, and exact diagnostics.
- `src/core/workflowRuntime.ts`: sequential result composition and branch/step state.
- `src/core/languageService.ts`: Dext completions, hover, signatures, and diagnostics.
- `src/core/contextResolver.ts`: immutable context snapshots.
- `src/core/axAdapter.ts`: Ax/Zod/JSON Schema contract boundary.
- `src/core/runtime.ts`: deterministic executor allowlist.
- `src/webview/codeEditor.ts`: CodeMirror Python language integration.

## Development

Requirements: Node.js 20 or newer and VS Code 1.105 or newer.

```bash
npm install
npm run check
```

Run `npm run test:host` for the VS Code activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` for a nonstandard VS Code installation or `DEXT_TEST_DOWNLOAD=1` for an isolated downloaded build.

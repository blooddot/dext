# Dext

Dext is a typed AI workflow editor for Visual Studio Code. Workflows use a deliberately small Python syntax, but Dext parses them as data and never starts or embeds a Python interpreter.

Without an Agent profile, Dext validates workflow structure, resolves immutable code references, and produces typed deterministic result previews. When a Codex or Claude CLI profile is selected, the same typed API contract is sent to that CLI and its structured output is validated before display.

## Workflow language

Natural language must be explicit through an API string argument; arbitrary text is a compile error.

```python
analysis = ask(input=f"""Explain this implementation and give refactoring requirements:
{ref.selection}""")

preview = agent(
    input=f"Implement the requested refactoring in {ref.selection}",
    apply=False,
)

if preview.patch:
    applied = apply(result=preview)
```

The input workflow language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, and `if`/`else` with `==` or `!=`. Restricted Python f-strings are accepted only as the `input` argument of `ask` and `agent`: an interpolation may be one `ref.*` value or a prior `Result`, never an arbitrary Python expression. `.dx` API files additionally support one typed `main()` function and explicit imports. User functions/classes, loops, reassignment, `eval`, `exec`, and system/file/network APIs are rejected. Execution is sequential; unselected and downstream steps are reported as `skipped`.

## Built-in API

- `ask(input, workspace?) -> ChatResult`
- `agent(input, apply=true, workspace?) -> AgentResult`
- `apply(result) -> ApplyResult`
- `terminal(command, cwd=".", timeout_ms=120000) -> TerminalResult`
- `skill(skill, input, workspace?) -> ChatResult`
- `mcp(tool, input={}) -> McpRawResult`
- `print(text, label?) -> PrintResult`
- `ui.choose(...)`, `ui.confirm(...)`, `ui.input(...) -> UiResult`

Every API output implements the shared `Result` contract. `ask` handles read-only explanation and analysis; `agent` handles continuous tasks and may return an auditable patch. `apply(result=...)` applies an `AgentResult` patch when one is present. Agent CLIs receive prior results as versioned `dext-result` JSON envelopes instead of interpolated strings. Result variables and fields such as `agent_result: AgentResult` and `agent_result.patch: PatchResult` are available to completion and hover.

`ask` is always read-only. `agent` defaults `apply=true`: in a trusted local workspace, the selected workspace is the Agent CLI working directory and the Agent may edit only that workspace. Set `apply=false` to require a read-only preview; when a change is proposed, the resulting `AgentResult` may include a patch for `apply`. Both APIs default `workspace` to the current project root.

```python
answer = ask(input=f"Explain this code: {ref.selection}")
preview = agent(input=f"Plan the requested change in {ref.file('docs/drag-drop.md')}", apply=False)
```

`terminal` is available only in a trusted local `file` workspace. Its `cwd` must stay inside the workspace, every command requires a VS Code modal confirmation, the timeout is capped at 10 minutes, and captured output is bounded. It returns `TerminalStatus = "succeeded" | "failed" | "timed_out"`; a nonzero exit code is a typed failed result, while rejecting the confirmation cancels that workflow step and skips downstream steps.

`print` renders its typed text result only in Dext Output and never writes to the integrated terminal.

Context values are `ref.selection`, `ref.active_file`, `ref.file("path")`, `ref.dir("path")`, and `ref.symbol("name")`:

- `ref.selection` resolves the current selection in the active editor.
- `ref.active_file` resolves the complete active editor file.
- `ref.file("path")` resolves a workspace file or an optional line/column range.
- `ref.dir("path")` resolves a workspace-contained directory without reading or expanding its contents.
- `ref.symbol("name")` asks VS Code's workspace symbol provider for a declaration and its source range.

Copying a VS Code selection, choosing a file or folder, or dropping one into Dext inserts an atomic `ref.file(...)` or `ref.dir(...)` chip. The chip can be removed atomically and participates in undo/redo.

The editor uses CodeMirror's Python grammar for syntax highlighting, indentation, bracket matching, and native editor behavior. Dext adds API completion, keyword and result-field completion, signature help, hover documentation, exact compiler diagnostics, and a lint gutter.

## Method configuration

Custom APIs live in `.dext/api/**/*.dx`. Directory segments become namespaces and each file exports one API through `main()`.

```python
# .dext/api/team/analyze.dx -> team.analyze
from common import ask

def main(input: str) -> ChatResult:
    return ask(input=input)
```

`.dx` uses a restricted Python-like syntax. It is parsed by Dext and never starts a Python interpreter. Imports are explicit and only refer to other `.dext/api` files; external files are not read until VS Code marks the workspace as trusted.

Typed results use Python's standard `TypedDict`, `Literal`, and `NotRequired` annotations rather than Dext-specific classes. The declared `kind` must be one `Literal` string; fields become the API output JSON Schema and member completions. TypedDict inheritance, `Protocol`, and complex generic types are intentionally unsupported.

```python
from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]
```

Standard skills are discovered in `<workspace>/.agents/skills`, `<workspace>/dext/skills`, then `dext.skillDirs`; earlier directories win duplicate names. `skill` defaults `workspace` to the current project and injects the selected `SKILL.md` into the current Agent task. `ui.*` waits for a semantic user answer and resumes the same workflow. `mcp` only accepts configured full tool names in `dext.mcpTools`, such as `docs.read`; the registry resolves that exact name to its configured server and underlying tool without splitting it. Duplicate full names are configuration errors. The initial transport is local stdio: each call sends JSON-RPC `initialize`, `notifications/initialized`, and `tools/call`, then closes the process. Commands inherit their environment; Dext neither stores nor renders credentials. MCP `structuredContent` is preserved as `McpRawResult.structured`; a `.dx` API returning a `TypedDict` adapts that structure into its declared result and validates it strictly.

```json
{
  "dext.mcpServers": [
    { "name": "docs", "transport": "stdio", "command": "my-docs-mcp", "args": ["--stdio"] }
  ],
  "dext.mcpTools": [
    { "server": "docs", "tool": "read", "description": "Read a document" }
  ]
}
```

```python
from typing import Literal, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str

def main(input: dict[str, object]) -> DocumentResult:
    return mcp(tool="docs.read", input=input)
```

Agent profiles are stored in VS Code extension global storage. The Run row exposes Agent, Model, Reasoning, and Speed selectors. Codex profiles read the local Codex model cache when available, including supported reasoning levels and speed tiers. Claude Code profiles use its native `opus`/`sonnet` aliases and current effort levels. A `.dx` file may override the Agent and Model with `@api(agent="codex", model="...")`; otherwise the Run selection is used. `Dext: Configure Agent` edits executable commands and custom model labels without handling credentials.

The AIOA profile connects to AIOA through an explicitly enabled local Chromium DevTools Protocol (CDP) port. It offers two modes:

- `Launch` is the default. It starts the configured AIOA executable with a loopback-only CDP port and waits for it to become ready. If AIOA is already running without CDP, quit it first and run again.
- `Attach` connects to an existing AIOA instance launched with `--remote-debugging-port=<port>`.

The AIOA window remains an AIOA-owned desktop application; Dext does not access private IPC, browser storage, or credentials. The first turn in a Dext Output session creates a task in the matching AIOA workspace and sends the fixed adapter rules once. Later turns reuse that task and send only their typed payload and current output schema. Clearing Output ends that association, while preserving the grouped conversation in Dext History; the next run creates a fresh AIOA task. Model, permission level, connectors, and workspace context remain controlled by AIOA, so the AIOA profile exposes `Active AIOA model` rather than duplicating those controls. CDP is bound to `127.0.0.1` only and must never be exposed on a LAN interface.

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
- `src/core/aioaCdp.ts`: local AIOA CDP attach/launch and Dext task-session adapter.
- `src/webview/codeEditor.ts`: CodeMirror Python language integration.

## Development

Requirements: Node.js 20 or newer and VS Code 1.105 or newer.

```bash
npm install
npm run check
```

Run `npm run test:host` for the VS Code activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` for a nonstandard VS Code installation or `DEXT_TEST_DOWNLOAD=1` for an isolated downloaded build.

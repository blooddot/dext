# Dext

Dext is a typed AI workflow editor for Visual Studio Code. Workflows use a deliberately small Python syntax, but Dext parses them as data and never starts or embeds a Python interpreter.

Without an Agent profile, Dext validates workflow structure, resolves immutable code references, and produces typed deterministic result previews. When a Codex or Claude CLI profile is selected, the same typed API contract is sent to that CLI and its structured output is validated before display.

## Workflow language

Natural language must be explicit through an API string argument; arbitrary text is a compile error.

```python
analysis = ask(input="Explain this implementation and give refactoring requirements:")

preview = agent(
    input="Implement the requested refactoring",
    apply=False,
)

if preview.patch:
    applied = apply(result=preview)
```

The input workflow language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, `if`/`else` with `==` or `!=`, and `for name in list:` over a homogeneous list. The loop variable takes the list's element type and only exists inside the body. A list comprehension, `[call(...) for name in list]`, is the one construct that runs concurrently: its branches cannot see one another, so Dext fans them out up to `dext.workflow.maxConcurrency` and collects the results in list order. One `for` clause, no `if` filter. `try`/`except` with an optional `finally` replaces the default all-or-nothing behavior: a failing step inside the body hands control to the handler and the workflow keeps going. `except Exception as name:` binds the failure message as a string, visible only inside the handler. There is one failure channel, so a named exception type is rejected rather than silently ignored, and stopping a run is never caught — cancellation passes through and the handler does not run. `ask` and `agent` accept ordinary strings. Dropping a file into either input writes a readable `@workspace/path#Lstart,end-Lend,end` token; the editor, Output, and History render that token as an atomic Chip while copy and execution retain the same readable string. Dext never inlines file contents into the prompt. `.dx` API files additionally support one typed `main()` function and explicit imports. User functions/classes, `while`, reassignment, `eval`, `exec`, and system/file/network APIs are rejected. Execution is sequential apart from comprehension fan-out; unselected and downstream steps are reported as `skipped`.

## Built-in API

- `ask(input, workspace?) -> ChatResult`
- `agent(input, apply=true, workspace?) -> AgentResult`
- `apply(result) -> ApplyResult`
- `terminal(command, cwd=".", timeout_ms=120000) -> TerminalResult`
- `skill(skill, input, workspace?) -> ChatResult`
- `mcp(tool, input={}) -> McpRawResult`
- `print(text, label?) -> PrintResult`
- `ui.choose(...)`, `ui.confirm(...)`, `ui.input(...) -> UiResult`

Everything beyond that list is project-local: a workspace defines its own APIs
as `.dx` files under `.dext/api/`, and their directory becomes the namespace, so
`.dext/api/workflow/feature.dx` registers `workflow.feature`. Dext ships no such
APIs of its own.

A project-local API composes the built-in `mcp`, `agent`, and UI APIs directly
rather than importing intermediate phase APIs. A typical feature workflow reads
context, makes a plan, gates on `ui.confirm`, implements, gates again, then
validates. Declaring optional `mcp_tool` and `mcp_input` parameters lets a
registered textual MCP tool run before the first Agent phase. Rules live under
`.dext/rules/`; every Agent phase declares the ordered rules it uses, and
confirmable actions such as code generation and commit stay explicit UI gates.

UI APIs return a result and resume the current workflow; they do not require a
separate callback registration. Assign the result when later steps need it:

```python
confirmation = ui.confirm(message="Apply this change?")
if confirmation.confirmed == True:
    print(text="Continue")
```

The selected value, confirmation state, or input text is also rendered in
Output and History after the interaction completes.

Every API output implements the shared `Result` contract. `ask` handles read-only explanation and analysis; `agent` handles continuous tasks and may return an auditable patch. `apply(result=...)` applies an `AgentResult` patch when one is present. Agent CLIs receive prior results as versioned `dext-result` JSON envelopes instead of interpolated strings. Result variables and fields such as `agent_result: AgentResult` and `agent_result.patch: PatchResult` are available to completion and hover.

`ask` is always read-only. `agent` defaults `apply=true`: in a trusted local workspace, the selected workspace is the Agent CLI working directory and the Agent may edit only that workspace. Set `apply=false` to require a read-only preview; when a change is proposed, the resulting `AgentResult` may include a patch for `apply`. Both APIs default `workspace` to the current project root.

```python
answer = ask(input="Explain this code:")
preview = agent(input="Plan the requested change", apply=False)
```

`terminal` is available only in a trusted local `file` workspace. Its `cwd` must stay inside the workspace, every command requires a VS Code modal confirmation, the timeout is capped at 10 minutes, and captured output is bounded. It returns `TerminalStatus = "succeeded" | "failed" | "timed_out"`; a nonzero exit code is a typed failed result, while rejecting the confirmation cancels that workflow step and skips downstream steps.

`print` renders its typed text result only in Dext Output and never writes to the integrated terminal.

Context values are `ref.selection`, `ref.active_file`, `ref.file("path")`, `ref.dir("path")`, and `ref.symbol("name")`:

- `ref.selection` resolves the current selection in the active editor.
- `ref.active_file` resolves the complete active editor file.
- `ref.file("path")` resolves a workspace file or an optional line/column range.
- `ref.dir("path")` resolves a workspace-contained directory without reading or expanding its contents.
- `ref.symbol("name")` asks VS Code's workspace symbol provider for a declaration and its source range.

Copying a VS Code selection, choosing a file or folder, or dropping one into an `ask`/`agent` input inserts a readable `@path` token in the normal quoted input text. The token is rendered as an atomic Chip, can be removed atomically, and participates in undo/redo. Existing legacy marker, f-string, and nested-quote reference forms are migrated to this representation when loaded.

The editor uses CodeMirror's Python grammar for syntax highlighting, indentation, bracket matching, and native editor behavior. Dext adds API completion, keyword and result-field completion, signature help, hover documentation, exact compiler diagnostics, and a lint gutter.

## Method configuration

Custom APIs live in `.dext/api/**/*.dx`. Directory segments become namespaces and each file exports one API through `main()`.

```python
# .dext/api/team/analyze.dx -> team.analyze
from common import ask

def main(input: str) -> ChatResult:
    return ask(input=input)
```

A conversation can be turned into a starting point instead of being written from scratch: right-click a Dext History entry and choose **Record Conversation as Dext Workflow**. Each successful turn becomes a step, a prompt repeated across turns becomes a `main()` parameter, a confirmation the conversation went through becomes a `ui.confirm` call, and a Code-mode turn is left as a comment. The file is written under `.dext/api` and opened for editing; it is a skeleton to revise, not a finished API.

`.dx` uses a restricted Python-like syntax. It is parsed by Dext and never starts a Python interpreter. Imports are explicit and only refer to other `.dext/api` files; external files are not read until VS Code marks the workspace as trusted. A nested `agent(...)` or `ask(...)` call may set `skills=["name"]` and `rules=["path.md"]`. Skills are explicit packages, while rules are ordered policy files. Rule paths are resolved only below `<workspace>/.dext/rules`; skill packages are discovered only below `<workspace>/.dext/skills` unless the user explicitly configures an additional `dext.skillDirs` directory. Dext loads selected skills first and rules last, so the API's narrow rules constrain the general skill workflow. These two parameters are internal workflow controls and do not appear in ordinary user-facing API signatures.

Typed results use Python's standard `TypedDict`, `Literal`, and `NotRequired` annotations rather than Dext-specific classes. The declared `kind` must be one `Literal` string; fields become the API output JSON Schema and member completions. TypedDict inheritance, `Protocol`, and complex generic types are intentionally unsupported.

```python
from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]
```

Standard skills are discovered in `<workspace>/.dext/skills`, then `dext.skillDirs`; earlier directories win duplicate names. `skill` defaults `workspace` to the current project and injects the selected `SKILL.md` into the current Agent task. `ui.*` waits for a semantic user answer and resumes the same workflow. `mcp` only accepts configured full tool names in `dext.mcpTools`, such as `docs.read`; the registry resolves that exact name to its configured server and underlying tool without splitting it. Duplicate full names are configuration errors. MCP calls require a trusted local workspace.

`dext.mcpServers` supports local `stdio` and Streamable HTTP (`2025-03-26`). HTTP endpoints must be HTTPS, or loopback HTTP for local development. URL userinfo, query strings, fragments, inline headers, and credentials are rejected. A bearer-enabled server stores its access token only through `Dext: Set MCP Access Token`, in VS Code SecretStorage and scoped to the current workspace. `Dext: Clear MCP Access Token` removes it; `Dext: Verify MCP Server` performs an authenticated initialization check. Dext never writes credentials to settings, project files, output, or logs. HTTP calls use JSON or SSE responses, reject redirects, and close negotiated sessions with `DELETE`. MCP `structuredContent` is preserved as `McpRawResult.structured`; a `.dx` API returning a `TypedDict` adapts that structure into its declared result and validates it strictly.

```json
{
  "dext.mcpServers": [
    { "name": "docs", "transport": "stdio", "command": "my-docs-mcp", "args": ["--stdio"] },
    {
      "name": "remote-docs",
      "transport": "http",
      "url": "https://mcp.example.test/v1",
      "auth": { "type": "bearer" }
    }
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

- `Launch` is the default. Dext first reuses the configured loopback endpoint when it is healthy. If it is unavailable, Dext asks the operating system for a free `127.0.0.1` port, starts AIOA with that loopback-only CDP port, and waits up to 60 seconds for it to become ready. The temporary endpoint is reused only for the current Dext extension session and is never written back to the profile. Startup diagnostics include the fixed endpoint, the last dynamic endpoint, process status, and the last CDP error.
- `Attach` connects to an existing AIOA instance launched with `--remote-debugging-port=<port>`.

The AIOA window remains an AIOA-owned desktop application; Dext does not access private IPC, browser storage, or credentials. The first turn in a Dext Output session creates a task in the matching AIOA workspace and sends the fixed adapter rules once. Later turns reuse that task and send only their typed payload and current output schema. Clearing Output ends that association, while preserving the grouped conversation in Dext History; the next run creates a fresh AIOA task. Model, permission level, connectors, and workspace context remain controlled by AIOA, so the AIOA profile exposes `Active AIOA model` rather than duplicating those controls. CDP is bound to `127.0.0.1` only and must never be exposed on a LAN interface.

Built-in APIs are always available. Custom APIs are scoped by explicit `import` or `from ... import ...` statements; completion, hover, signatures, and compilation use the same import scope.

## Inline completion

Inline completion is a separate backend from the agent profiles, because the Codex, Claude, and AIOA CLIs answer in seconds and a completion has to arrive between two keystrokes. Click the Dext status bar item, or run `Dext: Configure Completion Model`, and a short wizard asks for the API format, the base URL, the model ID, and the key, then offers to send one real request to check the whole thing works. The API key is never a setting: it is kept in VS Code's encrypted secret storage. Everything else lands in `dext.completion` in user settings, so a model configured once is available in every project.

Four formats are supported, and the choice has to match what the endpoint actually serves:

- `openai` — an OpenAI-compatible `/completions` endpoint that takes a `prompt` and a `suffix`. The fastest and most exact option, but only dedicated fill-in-the-middle models serve it.
- `openai-chat` — `/chat/completions`, which is what most providers expose, DeepSeek and Qwen included. There is no suffix field, so the code on either side of the cursor is sent as a chat prompt.
- `anthropic` — Claude's `/messages` endpoint, emulating fill-in-the-middle the same way.
- `ollama` — a local Ollama server called through `/api/generate`, using its own fill-in-the-middle fields. No key needed.

The two chat formats are slower and less exact than a real FIM model, and the reply is stripped of any code fence it comes wrapped in, so pick the fastest model the provider offers. Choosing the wrong format is the easiest way to get a backend that reports itself configured and completes nothing: the endpoint answers HTTP 200 with a body the other format cannot read a single character out of. Dext detects that case specifically and says which format to switch to, both during the connection test and on the first failed keystroke.

Completion is off until an endpoint and a model are both configured. Requests are debounced, cancelled when the next keystroke arrives, and cached per exact cursor position, so the same position never asks twice. Context is a prefix and suffix window measured in characters rather than lines, so one long generated line cannot exhaust the budget. Files excluded by `.gitignore` are skipped, and a `.dextignore` in the workspace root adds to those rules — read last, so it can also re-include a path `.gitignore` excluded. `.dx` files are left to the typed API completion provider. The status bar item turns completion off for the current window without editing settings, which is what makes it easy to live alongside another completion extension.

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
- `src/core/completionProvider.ts`: fill-in-the-middle backend, cache, and secret-stored key.
- `src/core/workflowRecorder.ts`: History conversation to `.dx` skeleton.
- `src/webview/codeEditor.ts`: CodeMirror Python language integration.

## Development

Requirements: Node.js 20 or newer and VS Code 1.105 or newer.

```bash
npm install
npm run check
```

Run `npm run test:host` for the VS Code activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` for a nonstandard VS Code installation or `DEXT_TEST_DOWNLOAD=1` for an isolated downloaded build.

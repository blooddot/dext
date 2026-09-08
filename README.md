# Dext

English | [简体中文](README.zh-CN.md)

Dext brings AI conversations and typed workflows to Visual Studio Code. Ask questions, delegate changes, work through plans, or compose reusable workflows with APIs, Skills, and MCP tools.

Workflows use a small subset of Python syntax. Dext parses and validates that syntax itself; no Python interpreter is required.

Without an Agent profile, Dext validates workflow structure, resolves immutable code references, and produces typed deterministic result previews. When a Codex CLI, Claude CLI, or DeepSeek Harness profile is selected, the same typed API contract is sent to that CLI and its structured output is validated before display.

## Features

- **Four input modes:** Agent for tasks, Ask for read-only questions, Plan for implementation plans, and Code for typed workflows.
- **Agent selection:** Codex CLI, Claude CLI, and DeepSeek Harness, with provider-specific model controls.
- **Typed editing:** API completion, parameter hints, hover information, diagnostics, and structured results.
- **Reusable resources:** project and global APIs, Skills, rules, and MCP tools.
- **Workspace context and history:** file and selection references, attachments, conversation tabs, favorites, and workflow recording.
- **Optional inline completion:** a separately configured completion model for source files.

## DeepSeek Harness

Install the tested release with `npm install -g @deepseek-ai/dsh@0.1.2-rc.1`. Configure its model credentials using Harness itself, then select **DeepSeek Harness** in Dext. **Dext: Configure Agent** accepts the executable path and discovers model and reasoning choices over ACP; leaving the model unset uses the Harness default. First selection also discovers models. Dext does not install Harness or manage its credentials.

The published Harness `0.1.2-rc.1` uses ACP SDK `1.4.0`, which Dext pins. Its [official CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) exposes `dsh --profile acp`; the installed package was checked for initialize, new/resume/close, model configuration, prompt and cancellation. New installations show all three backends. `dext.agentCli` can restrict that list.

Code workflows can use `ask(input="Explain this repository", cli="deepseek-harness")`. An optional model object takes `model` (the opaque ACP option value) and `reasoning`; use the composer for human-readable model names. Speed and service-tier controls are unavailable. Typed calls require a final JSON object and are validated by Dext. Invalid output reports failure without automatically repeating work that may already have changed files.

Dext launches one ACP process per active conversation, reuses its session, and stores the native session ID with a versioned workspace/permission/launch binding. Closing releases the process; persisted sessions remain available for resume. A permission change starts a new session with Dext's recorded context. Forks also start new sessions with the selected history because ACP does not provide native fork. Internal tool state is not copied. A failed resume is reported explicitly.

Ask, preview calls and Plan generation run read-only. Agent and explicit plan execution use the selected write scope. Dext's final configuration overlay pins all Harness permission presets to that scope, including a user's saved default. Escalations in restricted scopes are rejected because ACP does not identify their access boundary; known full-access requests use Dext confirmation. [Windows ACL confinement is partial](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md), including Everyone-writable objects and hard links; it is not strict isolation. Harness also permits its platform temporary areas in workspace-write mode.

`dext.agentCliArgs.deepseek-harness` accepts repeated `--patch <path>` launcher pairs in trusted workspaces. Dext owns the ACP profile and appends its permission patch last. Plugins are trusted code: overlays must preserve the shipped sandbox wiring and keep stdout exclusively JSON-RPC. Configuration changes require a new connection. `dext.agent.timeoutMs` bounds a turn. Updates arrive as committed messages and tool events, not token-by-token deltas; context occupancy is not reported as billed token usage.

AIOA/CDP support has been removed. Old AIOA conversations have no compatibility or migration support.

## Installation

Requires **VS Code 1.105 or newer**. For AI execution, install and authenticate the Agent CLI you intend to use. Dext does not bundle those applications or manage their login credentials.

1. Download the `dext-<version>.vsix` attachment for your chosen version from [GitHub Releases](https://github.com/blooddot/dext/releases).
2. Open the VS Code Command Palette and run **Extensions: Install from VSIX...**.
3. Select the downloaded file and reload VS Code if prompted.

If a release package is not available yet, follow [Development](#development) to build one locally. For later versions, download and install the corresponding VSIX again. See the [VS Code VSIX installation documentation](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix) for details.

## Quick start

1. Open your project folder in VS Code, then click Dext in the Activity Bar or run **Dext: Focus Input**.
2. Choose an Agent and model in the input area. Use **Dext: Configure Agent** if the executable path or model labels need adjustment.
3. Select **Ask**, enter a question such as “Explain the structure of this project,” and click **Send**. Add files or selections to the input when the question needs specific context.
4. Select **Agent** to request changes, or **Plan** to create and work through an implementation plan. These modes expose the **Workspace write** and **Full access** scopes.
5. Select **Code** to compose API calls, then click **Run**:

```python
answer = ask(input="Explain the structure of this project")
print(text=answer.text)
```

Agent, Ask, and Plan accept natural language directly. Code mode expects workflow syntax. Use **Dext: Open History** to revisit conversations; right-click a history entry to record it as a reusable workflow.

## Workflow language

In Code mode, natural language belongs in an API string argument; arbitrary text is a compile error.

```python
analysis = ask(input="Explain this implementation and give refactoring requirements:")

preview = agent(
    input="Implement the requested refactoring",
    apply=False,
)

if preview.patch:
    applied = apply(result=preview)
```

The input workflow language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, `if`/`else` with `==` or `!=`, and `for name in list:` over a homogeneous list. The loop variable takes the list's element type and only exists inside the body. A list comprehension, `[call(...) for name in list]`, is the one construct that runs concurrently: its branches cannot see one another, so Dext fans them out up to `dext.workflow.maxConcurrency` and collects the results in list order. One `for` clause, no `if` filter. `try`/`except` with an optional `finally` replaces the default all-or-nothing behavior: a failing step inside the body hands control to the handler and the workflow keeps going. `except Exception as name:` binds the failure message as a string, visible only inside the handler. There is one failure channel, so a named exception type is rejected rather than silently ignored, and stopping a run is never caught — cancellation passes through and the handler does not run. `ask` and `agent` accept ordinary strings. File selections and attachments can be inserted as readable `@workspace/path#Lstart,end-Lend,end` tokens; the editor, Output, and History render that token as an atomic Chip while copy and execution retain the same readable string. Dext never inlines file contents into the prompt. `.dx` API files additionally support a typed `main()` entry point, file-private typed helper functions, and explicit imports. Function definitions in the input composer, nested functions, recursive calls, classes, `while`, reassignment, `eval`, `exec`, and system/file/network APIs are rejected. Execution is sequential apart from comprehension fan-out; unselected and downstream steps are reported as `skipped`.

## Built-in API

- `create(type="api"|"mcp"|"rule"|"skill", input, scope="project"|"global") -> ChatResult` — create a resource from a description or URL (use in Code mode)
- `ask(input, skills?, rules?, workspace?) -> ChatResult`
- `plan(input, skills?, rules?, workspace?) -> ChatResult`
- `agent(input, apply=true, skills?, rules?, workspace?) -> AgentResult`
- `apply(result) -> ApplyResult`
- `terminal(command, cwd=".", timeout_ms=120000) -> TerminalResult`
- `skill(skill, input, workspace?) -> ChatResult`
- MCP tools are exposed as typed `mcp.<server>.<tool>(...)` APIs generated from manifests.
- `print(text, label?) -> PrintResult`
- `ui.choose(...)`, `ui.confirm(...)`, `ui.input(...) -> UiResult`

Project APIs live as `.dx` files under `.dext/api/`, and their directory becomes
the namespace, so `.dext/api/workflow/feature.dx` registers `workflow.feature`.
Global APIs are stored in Dext global storage and are available in every
workspace; a project API with the same id takes precedence.

A project-local API composes typed MCP, `agent`, and UI APIs directly
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

Every API output implements the shared `Result` contract. `ask` handles read-only explanation and analysis; `agent` handles free-form continuous tasks; `plan` creates, maintains, and executes implementation plans. `apply(result=...)` applies an `AgentResult` patch when one is present. Agent CLIs receive prior results as versioned `dext-result` JSON envelopes instead of interpolated strings. Result variables and fields such as `agent_result: AgentResult` and `agent_result.patch: PatchResult` are available to completion and hover.

`ask` is always read-only. `agent` and `plan` use the composer's `Workspace write` or `Full access` scope; in a trusted local workspace, `Workspace write` limits edits to the selected workspace. Dext itself can always persist Plan documents in its managed global storage. Both APIs default `workspace` to the current project root.

```python
answer = ask(input="Explain this code:")
result = agent(input="Implement the requested change")
```

`terminal` is available only in a trusted local `file` workspace. Its `cwd` must stay inside the workspace, every command requires a VS Code modal confirmation, the timeout is capped at 10 minutes, and captured output is bounded. It returns `TerminalStatus = "succeeded" | "failed" | "timed_out"`; a nonzero exit code is a typed failed result, while rejecting the confirmation cancels that workflow step and skips downstream steps.

`print` renders values only in Dext Output and never writes to the integrated terminal. Strings and primitive values are
shown as text; lists, dictionaries, and API results are rendered as JSON.

Context values are `ref.selection`, `ref.active_file`, `ref.file("path")`, `ref.dir("path")`, and `ref.symbol("name")`:

- `ref.selection` resolves the current selection in the active editor.
- `ref.active_file` resolves the complete active editor file.
- `ref.file("path")` resolves a workspace file or an optional line/column range.
- `ref.dir("path")` resolves a workspace-contained directory without reading or expanding its contents.
- `ref.symbol("name")` asks VS Code's workspace symbol provider for a declaration and its source range.

Copying a VS Code selection or choosing a file or folder inserts a readable `@path` token in the normal quoted input text. The token is rendered as an atomic Chip, can be removed atomically, and participates in undo/redo. Existing legacy marker, f-string, and nested-quote reference forms are migrated to this representation when loaded.

Selecting workspace code shows **Add to Dext** in a floating editor hover near the active selection cursor after a brief pause. The hover overlays the editor without adding a row or shifting code, and keeps keyboard focus in the editor. Click it to add the selected file range to Input. VS Code controls the hover's appearance and placement; symbol information may share the same hover. Toggle `dext.selectionActions.enabled` in Settings to show or hide this action immediately. Editor, file list, and file tab context menus use the same **Add to Dext** label and remain available when the selection action is disabled.

Press Ctrl+C (Cmd+C on macOS) on files in Explorer/Open Editors, an editor tab, or inside a file with no text selected, then Ctrl+V in Dext Input to insert references to the original paths. Multiple files and image files are supported without creating attachments. Ctrl+Shift+V pastes the path text as-is. Set `dext.copyFilePathOnCopy` to `false` to restore Explorer's native file copy and the editor's copy-line shortcut.

The editor uses CodeMirror's Python grammar for syntax highlighting, indentation, bracket matching, and native editor behavior. Dext adds API completion, keyword and result-field completion, signature help, hover documentation, exact compiler diagnostics, and a lint gutter.

## Method configuration

Custom APIs live in `.dext/api/**/*.dx`. Directory segments become namespaces and each file exports one API through `main()`.

```python
# .dext/api/team/analyze.dx -> team.analyze
from common import ask

def main(input: str) -> ChatResult:
    return ask(input=input)
```

`from playground import verify` imports the `main()` entry point of
`.dext/api/playground/verify.dx`; call it as `verify()`. An alias such as
`from playground import verify as check` is also supported. The imported API
must exist and load successfully.

Split a longer API into typed helper functions in the same file:

```python
# .dext/api/playground/develop.dx
from playground import verify

def report(checked: TerminalResult) -> PrintResult:
    if checked.status != "succeeded":
        return print(text=checked.stderr, label="Checks failed")
    return print(text=checked.stdout, label="Checks passed")

def main() -> PrintResult:
    checked = verify()
    return report(checked=checked)
```

Helpers may appear before or after `main()` and call other helpers or imported
APIs. Each call has its own parameters and local variables. Parameters require
type annotations; calls use keyword arguments and may omit parameters with
literal defaults. Every function declares and returns a Dext result, such as
`ChatResult`, `AgentResult`, `TerminalResult`, or `PrintResult`; returning a bare
string, boolean, or list is not supported. Use `return print(text=value)` to
return a summary or collection. `return` works inside `if`, `try`, and `except`;
`finally` runs before the return completes, except on cancellation. A path that
reaches the end without returning fails at runtime. Only `main()` is exported;
helpers cannot be imported from another file. Recursive calls and helper names
that conflict with APIs or imports are rejected. Helper calls, parameters, and
result fields have completion and signature/hover assistance in `.dx` files.

A conversation can be turned into a starting point instead of being written from scratch: right-click a Dext History entry and choose **Record Conversation as Dext Workflow**. Each successful turn becomes a step, a prompt repeated across turns becomes a `main()` parameter, a confirmation the conversation went through becomes a `ui.confirm` call, and a Code-mode turn is left as a comment. The file is written under `.dext/api` and opened for editing; it is a skeleton to revise, not a finished API.

Dext History is scoped to the current VS Code workspace. Conversations,
favorites, names, and open conversation tabs are restored after restarting VS
Code, but are not shared with other projects.

History turns offer rename, fork, copy as Markdown, and delete from Dext, in that order, in both their toolbar and context menu. The live Conversation toolbar places edit input and retry before these four actions. History's parent conversation toolbar offers continue, rename, fork, copy, favorite, archive, and delete. Shared actions use consistent icons and relative order, with delete last. Turn titles are saved separately from the original input; clearing a title restores its default.

Deleting a turn removes Dext's saved input/output record only. It does not erase CLI messages or undo file changes, and continuing the bound CLI session may still use the deleted turn's context. Dext retains CLI session IDs, including an empty conversation after its final displayed turn is deleted, so it can request the same session on restart. Resuming still requires that provider session to remain available. Retry appends a new execution to the conversation and can repeat write actions.

`.dx` uses a restricted Python-like syntax. It is parsed by Dext and never starts a Python interpreter. Imports are explicit; built-ins are available through `common`, and custom imports refer to `.dext/api` files. External files are not read until VS Code marks the workspace as trusted. A nested `agent(...)`, `ask(...)`, or `plan(...)` call may set `skills=["name"]` and `rules=["path.md"]`. Skills are explicit packages, while rules are ordered policy files. Rule paths are resolved only below `<workspace>/.dext/rules`; skill discovery follows the order described below. Dext loads selected skills first and rules last, so the API's narrow rules constrain the general skill workflow. These parameters appear in Dext signatures and completion; their contents are injected into the Agent instruction rather than forwarded as control fields to the provider.

Typed results use Python's standard `TypedDict`, `Literal`, and `NotRequired` annotations rather than Dext-specific classes. The declared `kind` must be one `Literal` string; fields become the API output JSON Schema and member completions. TypedDict inheritance, `Protocol`, and complex generic types are intentionally unsupported.

```python
from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]
```

Standard skills are discovered in `<workspace>/.dext/skills`, then Dext global
storage, then `dext.skillDirs`; earlier directories win duplicate names. `create`
can place a skill in either scope. `skill` defaults `workspace` to the current
project and injects the selected `SKILL.md` into the current Agent task.
`ui.*` waits for a semantic user answer and resumes the same workflow.

## MCP APIs

MCP manifests live in `<workspace>/.dext/mcp/*.jsonc` or Dext global storage:
one file declares one server and its explicit tool allowlist. Each enabled tool
becomes a typed API named `mcp.<server>.<tool>`, with completion, signature help,
required-argument validation, and structured result-field completion. Project
manifests take precedence when a server name collides. The `inputSchema` is
required; `outputSchema` is optional, but enables typed fields from MCP
`structuredContent`.

```jsonc
// .dext/mcp/docs.jsonc
{
  "name": "docs",
  "transport": "stdio",
  "command": "my-docs-mcp",
  "args": ["--stdio"],
  "tools": [{
    "name": "read",
    "description": "Read a document",
    "inputSchema": {
      "type": "object",
      "properties": { "uri": { "type": "string" } },
      "required": ["uri"]
    },
    "outputSchema": {
      "type": "object",
      "properties": { "content": { "type": "string" } },
      "required": ["content"]
    }
  }]
}
```

```python
document = mcp.docs.read(uri="README.md")
print(text=document.content)
```

For a stdio MCP that reads its credential from an environment variable, declare
the variable without putting the secret in the manifest:

```jsonc
{
  "name": "example-user-mcp",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "example-mcp"],
  "auth": { "type": "token", "env": "EXAMPLE_MCP_TOKEN" },
  "tools": []
}
```

MCP calls require a trusted local workspace. Manifests support local `stdio` and Streamable HTTP. HTTP endpoints must use HTTPS, or loopback HTTP for local development. URL userinfo, query strings, fragments, inline headers, and credentials are rejected. A bearer-enabled HTTP server stores its token only through `Dext: Set MCP Access Token`. A stdio server may declare `auth: {"type":"token","env":"ENV_NAME"}`; Dext then injects its SecretStorage token into that child-process environment variable. Tokens are keyed by server and manifest scope: project manifests use workspace-scoped keys, while global manifests use global keys. Do not put credentials in a manifest or stdio arguments. `Dext: Clear MCP Access Token` removes the selected credential; `Dext: Verify MCP Server` performs an authenticated HTTP initialization check. Editing, creating, or deleting a manifest reloads its APIs automatically.

## Agent configuration

Agent profiles are stored in VS Code extension global storage. The input area exposes Agent, Model, Reasoning, and Speed selectors where supported by the provider. Codex profiles read the local Codex model cache when available, including supported reasoning levels and speed tiers. Claude Code profiles use its native `opus`/`sonnet` aliases and configured effort levels. A `.dx` file may override the Agent and Model with `@api(agent="codex", model="...")`; otherwise the input selection is used. `Dext: Configure Agent` edits executable commands and custom model labels without handling credentials.

The built-in `agent`, `ask`, `plan`, `skill`, and `create` APIs also accept optional per-call `cli` and `model` arguments. `cli` is `"codex"` or `"claude"`. For Claude, `model` is `"sonnet"` or `"opus"`; for Codex it is a dictionary with a required `model` ID from the configured Codex model list, optional `reasoning` (`"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"`), and optional `speed` (`"standard"`, `"fast"`). The selected model must support the requested reasoning level and Fast mode. If no local model list is available, Codex IDs are accepted as strings until the catalog is available.

```python
ask(input="Explain this code", cli="claude", model="sonnet")
agent(input="Implement the change", cli="codex")
```

Omit both `cli` and `model` to use the current Input selection (existing `.dx` decorator overrides still apply). Providing only `cli` uses that CLI's own default configuration, without inheriting Input or decorator model, reasoning, or speed settings—even when the CLI matches Input. Providing both uses the explicit model options and leaves omitted reasoning/speed options to the CLI defaults. Providing only `model` uses Input's selected CLI; unspecified options retain Input settings when the model is unchanged, otherwise they use CLI defaults. These overrides apply only to the current call. Codex Speed controls Standard/Fast processing directly.

The `dext.agentCli` setting controls which built-in Agent profiles are shown in the composer. It defaults to `codex` and `claude`; edit the list to choose which of these profiles to display.

Built-in APIs are always available. Custom APIs are scoped by explicit `import` or `from ... import ...` statements; completion, hover, signatures, and compilation use the same import scope.

## Inline completion

Inline completion is a separate backend from the agent profiles, so completion requests can use a model configured for low-latency suggestions while typing. Click the Dext status bar item, or run `Dext: Configure Completion Model`, and a short wizard asks for the API format, the base URL, the model ID, and the key, then offers to send one real request to check the whole thing works. The API key is never a setting: it is kept in VS Code's encrypted secret storage. Everything else lands in `dext.completion` in user settings, so a model configured once is available in every project.

Four formats are supported, and the choice has to match what the endpoint actually serves:

- `openai` — sends `prompt` and `suffix` to an OpenAI-compatible `/completions` endpoint; requires a model and endpoint that support fill-in-the-middle completion.
- `openai-chat` — sends the code on either side of the cursor as a chat prompt to `/chat/completions`.
- `anthropic` — sends a chat-style completion request to `/messages`.
- `ollama` — calls a local Ollama server through `/api/generate`, using its fill-in-the-middle fields. No key needed.

Latency and completion quality depend on the model and endpoint. Dext strips code fences from chat responses. A format mismatch can produce an HTTP 200 response with no usable completion text; Dext reports recognized mismatches during connection tests and completion requests.

Completion is off until an endpoint and a model are both configured. New requests are debounced; an in-flight generation can be reused when subsequent typing matches it. Context is a prefix and suffix window measured in characters rather than lines, so one long generated line cannot exhaust the budget.

How long a suggestion takes to appear is mostly a question of how much work happens between the keystroke and the first thing worth showing, so several things keep that down.

The reply is streamed, and the request is abandoned as soon as the completion is decidably finished rather than when the model reaches its token budget. Where extra lines could not be used anyway — the cursor is mid-line, or inside a comment — the model is told to stop at the newline, which usually means a handful of tokens instead of a block.

A generation also outlives the keystroke that started it. The editor cancels the previous request every time a character is typed, and following that would mean throwing away a nearly finished answer and starting from nothing several times a second; instead the request keeps running and the next keystroke waits on the same answer, minus the characters typed since. It is only abandoned once what was typed has diverged from what it was writing. For the same reason there is nothing to debounce while a generation is already in flight, so those keystrokes skip the debounce entirely. Once an answer has arrived the cache continues the job: typing the beginning of what was suggested serves the rest of that same suggestion from memory.

The prefix window is quantised and snapped to a line boundary to keep prompt prefixes stable between nearby keystrokes. This can improve reuse on backends that support prompt caching.

Providers meter this kind of backend by requests per second, and one that allows four of them refuses the fifth rather than queueing it. No setting can predict that limit, so Dext learns it: requests go out as fast as they are asked for until one is refused with HTTP 429, and are then spaced out by an interval that doubles while refusals continue and relaxes once they stop. A `Retry-After` is believed over that guess. This happens on its own, so `dext.completion.debounceMs` only needs raising if the backend is metered tightly enough that even the first refusal is worth avoiding.

If suggestions come out truncated, raise `dext.completion.maxTokens`; it is the main thing trading latency against length. Files excluded by `.gitignore` are skipped, and a `.dextignore` in the workspace root adds to those rules — read last, so it can also re-include a path `.gitignore` excluded. `.dx` files are left to the typed API completion provider. The status bar item turns completion off for the current window without editing settings, which is what makes it easy to live alongside another completion extension.

## Architecture

- `src/core/workflow.ts`: Lezer Python parser traversal, restricted AST, semantic types, and exact diagnostics.
- `src/core/workflowRuntime.ts`: sequential result composition and branch/step state.
- `src/core/languageService.ts`: Dext completions, hover, signatures, and diagnostics.
- `src/core/contextResolver.ts`: immutable context snapshots.
- `src/core/axAdapter.ts`: Ax/Zod/JSON Schema contract boundary.
- `src/core/runtime.ts`: deterministic executor allowlist.
- `src/core/customApi.ts`: `.dext/api` loader, imports, signatures, and custom plans.
- `src/core/agentRunner.ts`: structured Codex/Claude CLI adapter boundary.
- `src/core/completionProvider.ts`: fill-in-the-middle backend, cache, and secret-stored key.
- `src/core/workflowRecorder.ts`: History conversation to `.dx` skeleton.
- `src/webview/codeEditor.ts`: CodeMirror Python language integration.

## Development

Use the Node.js version pinned in `package.json` under `volta` (currently **22.23.2**) and VS Code 1.105 or newer.

```bash
git clone https://github.com/blooddot/dext.git
cd dext
npm ci
npm run check
```

Run `npm run test:host` for the VS Code activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` for a nonstandard VS Code installation or `DEXT_TEST_DOWNLOAD=1` for an isolated downloaded build.

Press **F5** in VS Code and choose **Run Dext Extension** to launch an Extension Development Host. Use `npm run watch` when iterating on the bundled code.

## Packaging and releases

```bash
npm run package
```

This runs lint, type checking, unit tests, the build, and webview asset checks before creating `release/dext-<version>.vsix`. The version comes from `package.json`.

The `release/` directory is created automatically, ignored by Git, and excluded from the VSIX contents. Packages for different versions are kept; packaging the same version replaces its existing file. For example, version `0.1.0` produces `release/dext-0.1.0.vsix`.

To publish a version on GitHub:

1. Update the version in `package.json` and `package-lock.json`, and add the release notes to [CHANGELOG.md](CHANGELOG.md).
2. Run `npm run package`, install the generated VSIX, and check the main user flows.
3. Commit the source changes and create a matching Git tag, such as `v0.1.0`.
4. Push the commit and tag, create a GitHub Release for that tag, and upload the VSIX from `release/` as an attachment.

Keep published installers with their corresponding Releases so that older versions remain easy to find. `npm run package` only creates a local package; it does not upload or publish it.

## Feedback and license

Report bugs or request features in [GitHub Issues](https://github.com/blooddot/dext/issues). Include the Dext and VS Code versions, reproduction steps, and relevant logs with credentials removed.

Dext is source-available under the [PolyForm Perimeter License 1.0.1](LICENSE), with separate commercial licensing available by agreement. Ordinary use, including internal business use, is permitted subject to the license. Using Dext to provide a competing product or service to others requires separate authorization, even if that offering is free.

See [commercial licensing](COMMERCIAL-LICENSING.md) for the scope and how to request an agreement. This is a source-available license, not an OSI-approved open-source license. Third-party components retain their own licenses. See [CHANGELOG.md](CHANGELOG.md) for version notes.

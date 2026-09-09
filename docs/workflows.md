# Workflow and API reference

English | [简体中文](workflows.zh-CN.md)

[Back to README](../README.md)

Compose calls in Code mode and save repeated workflows as project APIs. This reference covers syntax, built-in APIs, code references, custom APIs, Skills, and conversation history.

[Workflow language](#workflow-language) · [Built-in API](#built-in-api) · [File and selection references](#file-and-selection-references) · [Custom APIs and Skills](#custom-apis-and-skills) · [Conversation history and workflow recording](#conversation-history-and-workflow-recording) · [Imports, Skills, and rules](#imports-skills-and-rules) · [Custom result types](#custom-result-types) · [Execution and previews](#execution-and-previews)

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

The input workflow language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, `if`/`else` with `==` or `!=`, and `for name in list:` over a homogeneous list. The loop variable takes the list's element type and only exists inside the body.

A list comprehension, `[call(...) for name in list]`, is the one construct that runs concurrently: its branches cannot see one another, so Dext fans them out up to `dext.workflow.maxConcurrency` and collects the results in list order. One `for` clause, no `if` filter.

`try`/`except` with an optional `finally` replaces the default all-or-nothing behavior: a failing step inside the body hands control to the handler and the workflow keeps going. `except Exception as name:` binds the failure message as a string, visible only inside the handler. There is one failure channel, so a named exception type is rejected rather than silently ignored, and stopping a run is never caught — cancellation passes through and the handler does not run.

`ask` and `agent` accept ordinary strings. File selections and attachments can be inserted as readable `@workspace/path#Lstart,end-Lend,end` tokens; the editor, Output, and History render that token as an atomic Chip while copy and execution retain the same readable string. Dext never inlines file contents into the prompt.

`.dx` API files additionally support a typed `main()` entry point, file-private typed helper functions, and explicit imports. Function definitions in the input composer, nested functions, recursive calls, classes, `while`, reassignment, `eval`, `exec`, and system/file/network APIs are rejected.

Execution is sequential apart from comprehension fan-out; unselected and downstream steps are reported as `skipped`.

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
- UI interactions: `ui.select`, `ui.radio`, `ui.checkbox`, `ui.input`, `ui.confirm`, `ui.alert`, `ui.form`.

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

## File and selection references

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

## Custom APIs and Skills

Custom APIs live in `.dext/api/**/*.dx`. Directory segments become namespaces and each file exports one API through `main()`. The Code input accepts qualified calls such as `playground.verify()` without imports, or imported names such as `verify()`. Inside `.dx` files, custom API calls require explicit imports. Both forms support completion, signature help, and hover information.

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

## Conversation history and workflow recording

A conversation can be turned into a starting point instead of being written from scratch: right-click a Dext History entry and choose **Record Conversation as Dext Workflow**. Each successful turn becomes a step, a prompt repeated across turns becomes a `main()` parameter, a confirmation the conversation went through becomes a `ui.confirm` call, and a Code-mode turn is left as a comment. The file is written under `.dext/api` and opened for editing; it is a skeleton to revise, not a finished API.

Dext History is scoped to the current VS Code workspace. Conversations,
favorites, names, and open conversation tabs are restored after restarting VS
Code, but are not shared with other projects.

History turns offer rename, fork, copy as Markdown, and delete from Dext, in that order, in both their toolbar and context menu. The live Conversation toolbar places edit input and retry before these four actions. History's parent conversation toolbar offers continue, rename, fork, copy, favorite, archive, and delete. Shared actions use consistent icons and relative order, with delete last. Turn titles are saved separately from the original input; clearing a title restores its default.

Deleting a turn removes Dext's saved input/output record only. It does not erase CLI messages or undo file changes, and continuing the bound CLI session may still use the deleted turn's context. Dext retains CLI session IDs, including an empty conversation after its final displayed turn is deleted, so it can request the same session on restart. Resuming still requires that provider session to remain available. Retry appends a new execution to the conversation and can repeat write actions.

## Imports, Skills, and rules

`.dx` uses a restricted Python-like syntax. It is parsed by Dext and never starts a Python interpreter. Imports are explicit; built-ins are available through `common`, and custom imports refer to `.dext/api` files. External files are not read until VS Code marks the workspace as trusted. A nested `agent(...)`, `ask(...)`, or `plan(...)` call may set `skills=["name"]` and `rules=["path.md"]`. Skills are explicit packages, while rules are ordered policy files. Rule paths are resolved only below `<workspace>/.dext/rules`; skill discovery follows the order described below. Dext loads selected skills first and rules last, so the API's narrow rules constrain the general skill workflow. These parameters appear in Dext signatures and completion; their contents are injected into the Agent instruction rather than forwarded as control fields to the provider.

Standard skills are discovered in `<workspace>/.dext/skills`, then Dext global
storage, then `dext.skillDirs`; earlier directories win duplicate names. `create`
can place a skill in either scope. `skill` defaults `workspace` to the current
project and injects the selected `SKILL.md` into the current Agent task.
`ui.*` waits for a semantic user answer and resumes the same workflow.

## Custom result types

Typed results use Python's standard `TypedDict`, `Literal`, and `NotRequired` annotations rather than Dext-specific classes. The declared `kind` must be one `Literal` string; fields become the API output JSON Schema and member completions. TypedDict inheritance, `Protocol`, and complex generic types are intentionally unsupported.

```python
from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]
```


## Execution and previews

Without an Agent profile, Dext validates workflow structure, resolves immutable code references, and produces typed deterministic result previews. With a profile selected, the same typed API contract is sent to the CLI and its structured output is validated before display. A preview does not mean an AI task has run.

## UI interactions and forms

All UI calls wait for the user's answer and produce one workflow step. `presentation="inline"` places the interaction above Process in its conversation; `"dialog"` uses a dialog. Waiting pauses only the calling workflow. Stopping the task interrupts the wait and skips subsequent steps.

```text
ui.select(label, options, multiple=False, placeholder="Select…", presentation="dialog")
ui.radio(label, options, allow_custom=False, custom_placeholder="", presentation="dialog")
ui.checkbox(label, options, allow_custom=False, custom_placeholder="", presentation="dialog")
ui.input(label, placeholder="", multiline=False, presentation="dialog")
ui.confirm(message, confirm_label="Continue", cancel_label="Cancel", presentation="dialog")
ui.alert(message, acknowledge_label="OK", presentation="dialog")
ui.form(title, fields, description="", submit_label="Submit", cancel_label="Cancel", show_cancel=True, presentation="inline")
```

| API / field | Control | Result payload |
| --- | --- | --- |
| `ui.select` / `select` | Collapsed single or multiple dropdown | `type="select"`, `selected` array |
| `ui.radio` / `radio` | Expanded mutually exclusive options | `type="radio"`, `selected` array and optional `custom` |
| `ui.checkbox` / `checkbox` | Expanded independent checkboxes | `type="checkbox"`, `selected` array and optional `custom` |
| `ui.input` / `input` | Single or multiline text | `type="input"`, string `value` |
| `ui.confirm` | Confirm / cancel buttons | `type="confirm"`, boolean `confirmed` |
| `ui.alert` | Acknowledge information | `type="alert"`, `status="acknowledged"` or `"dismissed"` |
| `ui.form` | Submit all fields together | `type="form"`, `status="submitted"` or `"cancelled"`, `answers` keyed by field ID |

API results include `kind="ui"`. Field answers inside `answers` contain only `type` and their value properties. A field description creates no interaction itself; never put executing API calls inside `fields`.

```python
fields = [
    {"id": "environment", "type": "select", "label": "Environment", "options": [
        {"value": "dev", "label": "Development", "description": "Local environment"},
        {"value": "test", "label": "Testing"}
    ]},
    {"id": "approach", "type": "radio", "label": "Approach", "options": ["inspect", "change"], "allow_custom": True},
    {"id": "checks", "type": "checkbox", "label": "Checks", "options": ["types", "tests", "build"], "required": False},
    {"id": "details", "type": "input", "label": "Details", "multiline": True, "required": False},
    {"id": "run_tests", "type": "radio", "label": "Run tests?", "options": [
        {"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}
    ]}
]
reply = ui.form(title="Settings", fields=fields, submit_label="Apply settings")
if reply.status == "submitted":
    if reply.answers["run_tests"].selected[0] == "yes":
        print(text="Run the selected checks")
```

Fields have a unique `id`, `label`, optional `description`, `required` (default `True`) and `default`. Without an explicit default, form fields start unanswered. Choice defaults are arrays of option values; input defaults are strings. Default values must satisfy the field contract. Options are nonempty lists of strings or `{value, label, description?}` objects with unique string values. A string option is its own value. `radio` and `checkbox` do not accept `multiple`; only `select` supports it. Dropdowns do not accept custom text. Radio custom text excludes predefined options; checkbox custom text may accompany selections.

Required choices need a selection or allowed custom answer. Required input uses trimmed text to check emptiness, but preserves the submitted text. Optional empty fields are omitted. A yes/no question is an ordinary radio: `selected=["no"]` is a submitted answer, never cancellation or a boolean. Use explicit string comparison in workflow branches.

Shortcuts accept string option lists. `ui.radio` preselects the first item, `ui.checkbox` starts empty and permits an empty submission, and `ui.select` starts at its placeholder and requires a selection. `ui.input` preserves empty strings (`value=""`) on submission; cancellation omits `value`. Cancelled selection shortcuts return their own result type with `selected=[]` and no custom draft. Use `ui.form` to distinguish cancellation from an empty submission.

Cancelling or closing a form returns `status="cancelled", answers={}`; submitting an empty-field form returns `status="submitted", answers={}`. `fields=[]` can express confirmation or information-only dialogs. `show_cancel=False` hides the cancel button, while the close action and stopping the task remain available. Confirm closes as `confirmed=False`. Alert's main button acknowledges; its close button or Escape dismisses. Clicking the backdrop does not dismiss an alert. Acknowledging information does not grant permission for a subsequent operation.

Dropdown Escape closes the option popup first; another Escape closes the container. Radio supports arrow keys, checkboxes support Space, and dialogs restore focus. Pending requests and non-secret drafts survive conversation switches and Webview reconstruction while the host execution remains live. Completed requests show read-only summaries. Historical requests after a host restart are closed.

Workflow and Agent inputs share controls. Native Agent questions still return one answer per question, preserve asynchronous answering and Skip, and clear secret input on submission without storing it in drafts or history. Public fields do not expose secret inputs.

Limits: 32 fields, 200 options per field, 2,000 characters per label/value, 20,000 per text, and 200,000 UTF-8 bytes per form or answer payload. Unsupported fields/attributes, duplicate IDs/options/selections and answers not matching the live request are rejected. Unknown historical results use bounded, escaped read-only text/JSON; they never resume execution. Search, remote options, free creation, virtual lists, conditional fields and nested groups are outside this API version. Ordinary output uses `print`; progress remains in Process/Todo.

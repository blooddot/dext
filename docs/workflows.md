# Workflow and API reference

English | [简体中文](workflows.zh-CN.md)

[Back to README](../README.md)

Compose calls in Code mode and save repeated workflows as project APIs. This reference covers syntax, built-in APIs, code references, custom APIs, Skills, and conversation history.

[Workflow language](#workflow-language) · [Built-in API](#built-in-api) · [Templates](#templates) · [File and selection references](#file-and-selection-references) · [Custom APIs and Skills](#custom-apis-and-skills) · [Conversation history and workflow recording](#conversation-history-and-workflow-recording) · [Turn and Build review](#turn-and-build-review) · [Imports, Skills, and rules](#imports-skills-and-rules) · [Custom result types](#custom-result-types) · [Execution and previews](#execution-and-previews)

## Workflow language

Input uses Monaco in its existing panel, with the Code selector and footer controls in the same positions. Enter inserts a line in Code and Ctrl/Cmd+Enter runs it. Chat modes retain the configured send behavior; Shift+Enter inserts a line. An open completion list takes priority over sending.

Completion, hover, parameter help and diagnostics use native editor widgets. Call trigger characters start parameter help, Escape dismisses it, and Ctrl/Cmd+Shift+Space requests it explicitly. F12 or Ctrl/Cmd+click opens API definitions, including declarations from the current MCP registry.

File and image chips support atomic selection, deletion and undo. Copying, saved drafts and execution retain complete `@path` source. Long labels are shortened; hover shows the full path. Alt+Enter beside a chip opens the reference, and Ctrl/Cmd+Shift+V pastes literal text. Replace a chip to change its path. Native Find searches ordinary editing text, not the full paths hidden inside chips.

In Code mode, natural language belongs in an API string argument; arbitrary text is a compile error.

```python
analysis = ask(input="Explain this implementation and give refactoring requirements:")

preview = agent(
    input="Implement the requested refactoring",
    apply=False,
)

# Report conclusions as text without producing a patch.
summary = agent(
    input="Summarize the refactoring plan",
    apply=False,
    patch=False,
)

if preview.patch:
    applied = apply(result=preview)
```

The input workflow language supports assignment, keyword-only API calls, strings (including triple-quoted strings), numbers, booleans, homogeneous lists, result member access, comments, `if`/`elif`/`else`, `for name in list:` over a homogeneous list, and `while` for sequential retry flows. A variable may be reassigned anywhere, including in plain sequential code, as long as it keeps the type it was first bound to. A `while` loop is capped at 100 iterations, and a binding created inside a loop body does not escape it.

### Text and value expressions

Dext evaluates pure expressions itself — no API round trip, no Python interpreter. A value the compiler can determine is folded while compiling, so `"a" + "b"` behaves exactly like `"ab"` everywhere, including in checks such as UI form validation.

| Form | Example | Notes |
| --- | --- | --- |
| Concatenation | `"Review: " + answer.text` | Both sides must be strings |
| Repetition | `"-" * 3` | `---` |
| Arithmetic | `2 + 3 * 4`, `7 // 2`, `2 ** 8` | Numbers only |
| f-string | `f"{answer.text} ({checked.exit_code})"` | Replacement fields, conversions, and format specs |
| `%` formatting | `"%s: %d" % [name, count]` | The arguments are a list or a tuple |
| Tuple | `("a", 1)`, `(value,)`, `1, 2` | A tuple literal, which is a list |
| `str.format` | `"{} and {}".format("a", "b")` | Also `{0}`, `{name}`, and `{0[name]}` |
| Indexing and slicing | `text[0]`, `text[1:4]`, `text[::-1]` | Negative offsets count from the end; lists work the same way |
| Membership | `"done" in answer.text` | Strings, lists, and dictionaries |
| Comparisons | `a == b`, `a != b`, `a < b`, `a <= b`, `a > b`, `a >= b` | Ordering needs two strings or two numbers |
| Boolean logic | `a and b`, `a or b`, `not a` | Operands must be boolean; use `bool(value)` to convert |

An f-string field takes an optional conversion and format spec: `f"{value!r}"`, `f"{count:,}"`, `f"{ratio:.1%}"`, `f"{width:>8}"`, `f"{value=}"`, and nested specs such as `f"{value:{width}}"`. Doubled braces (`{{`) print a literal brace.

String methods are available on any string value: `upper`, `lower`, `casefold`, `capitalize`, `title`, `swapcase`, `strip`, `lstrip`, `rstrip`, `removeprefix`, `removesuffix`, `replace`, `split`, `rsplit`, `splitlines`, `join`, `startswith`, `endswith`, `find`, `rfind`, `index`, `rindex`, `count`, `partition`, `rpartition`, `center`, `ljust`, `rjust`, `zfill`, `expandtabs`, `format`, and the `is*` predicates (`isalnum`, `isalpha`, `isdigit`, `isnumeric`, `isspace`, `isupper`, `islower`, `istitle`, `isidentifier`, `isascii`).

These pure helpers are compiled the same way: `len`, `str`, `repr`, `int`, `float`, `bool`, `abs`, `round`, `min`, `max`, `sorted`, `sum`, `range`, `list`, `reversed`, `any`, `all`. `range(3)` is a list of numbers, so `for index in range(3):` works; `sorted(names)` keeps the element type it was given. `range` is capped at 100000 values.

Dext keeps Python semantics for these operations, with four deliberate differences:

- `+` on a string requires another string. Write `f"{value}"` or `str(value)` to append a number.
- Tuples are written the Python way but are lists: `("a", 1)`, `(value,)`, `()`, and the bare `1, 2` all produce a list, so `(1, 2) == [1, 2]` is true and the length is not fixed. Unpacking stays unsupported, because a name binds once and a list has no fixed arity: `a, b = pair` and `for key, value in items:` are rejected. Read the entries instead (`pair[0]`, `pair[1]`), or iterate `for item in items:` when each item is an object with named fields. Dictionary keys are strings, so a tuple cannot be a key.
- `%` takes its arguments as a list: `"%s %d" % ["total", 3]` or `"%s %d" % ("total", 3)`. To format a list value itself, wrap it the way Python wraps a single-element tuple: `"%s" % (items,)`.
- Conditions must be boolean. `if answer.text:` is rejected; write `if bool(answer.text):`, or compare the value.
- Bytes literals (`b"..."`) are rejected; Dext text is UTF-8 strings throughout.
- There is no augmented assignment. `text += line` is rejected; write `text = text + line` instead, or collect repeated text in a list and join it with `"\n".join(lines)`.

A value that is not a compile-time constant becomes its own `=` step in Output, exactly like `text = answer.text` always did. A reassigned name does too, even when its value is a constant: the runtime has to hold the current value so later reads see the assignment that last ran.

A list comprehension, `[call(...) for name in list]`, is the one construct that runs concurrently: its branches cannot see one another, so Dext fans them out up to `dext.workflow.maxConcurrency` and collects the results in list order. One `for` clause, no `if` filter.

`try`/`except` with an optional `finally` replaces the default all-or-nothing behavior: a failing step inside the body hands control to the handler and the workflow keeps going. `except Exception as name:` binds the failure message as a string, visible only inside the handler. There is one failure channel, so a named exception type is rejected rather than silently ignored, and stopping a run is never caught — cancellation passes through and the handler does not run.

`ask` and `agent` accept ordinary strings. File selections and attachments can be inserted as readable `@workspace/path#Lstart,end-Lend,end` tokens; the editor, Output, and History render that token as an atomic Chip while copy and execution retain the same readable string. Dext never inlines file contents into the prompt.

`.dx` API files additionally support a typed `main()` entry point, file-private typed helper functions, explicit imports, and bounded `while` retry loops. Function definitions in the input composer, nested functions, recursive calls, classes, reassignment that changes a variable's type, `eval`, `exec`, and system/file/network APIs are rejected.

Execution is sequential apart from comprehension fan-out; unselected and downstream steps are reported as `skipped`.

## Built-in API

- **Create resource** opens a dedicated tab using the same Conversation and Input layout. Choose **API / MCP / Rule / Skill**, then **Project / Global** (the menu shows the destination directory). Select **New resource** or an existing resource, describe your changes, and review the draft or diff before saving. Saving keeps the tab open for further revisions; changing an existing resource’s destination creates a copy. Resource targets, drafts, and conversations are restored from History.
- `ask(input, skills?, rules?, workspace?) -> AskResult`
- `plan(input, skills?, rules?, workspace?) -> PlanResult`
- `agent(input, apply=true, patch=true, skills?, rules?, workspace?) -> AgentResult` — `patch=false` reports conclusions as text without producing a patch.
- `template(input, source, values={}, skills?, rules?, workspace?) -> TemplateResult` — renders text from a template file ([templates](#templates)).
- `apply(result) -> ApplyResult`
- `terminal(command, cwd=".", env={}, timeout_ms=120000) -> TerminalResult` — runs an arbitrary command in the platform shell. `env` supplies string environment variables to that command.
- `skill(skill, input, workspace?) -> SkillResult`
- MCP tools are exposed as typed `mcp.<server>.<tool>(...)` APIs generated from manifests.
- `print(text, label?) -> PrintResult`

Only these top-level APIs are built in. UI interactions live under `ui.*`; a
confirmation or form can use `on_cancel="abort"` to cancel the current custom
API without a separate workflow-control API. Node standard-library access is
provided only under the whitelisted `node.*` namespace: `node.url`,
`node.path`, `node.querystring`, compatible `node.util` exports,
`node.fs`, and `node.http.request`. Node function names retain their
native camelCase spelling. File and HTTP calls require a trusted workspace;
commands continue to use `terminal`.

`node.fs.readFile(path, encoding="utf8")` accepts absolute paths, including
files outside the workspace, using Node's native path handling. Relative paths
resolve from the workspace root and must stay inside it, including through
symbolic links. Other `node.fs` calls require workspace-relative paths that
stay inside the workspace.

`node:crypto`, `node:zlib`, `node:timers/promises`, and environment-sensitive
`node:os` calls are catalogued as future candidates, not callable APIs. Raw
process, socket, stream, worker, VM, module-loader, and server-listening APIs
remain outside `.dx`.
- UI interactions: `ui.select`, `ui.radio`, `ui.checkbox`, `ui.input`, `ui.confirm`, `ui.alert`, `ui.form`.

### Templates

A rule can only ask a model to follow a template, so a model that drifts changes the output's structure. `template` removes that: the model fills the template's fields, and Dext renders the headings, the section order and the list markers from the template file itself. A model can therefore never add, rename, reorder or drop a section.

A template is a text file whose YAML front matter declares the required `format` and one entry per field, followed by the body that places those fields with `{{field}}` placeholders. A field entry is either a description string or a mapping:

```markdown
---
dext-template:
  format: markdown
  number: Four-digit record number, for example "0081"
  title: Short title naming the decision
  status:
    type: enum
    values: [accepted, rejected, deprecated]
    description: Decision status
  positive:
    type: lines
    description: One benefit per line
  sources:
    type: lines
    optional: true
    description: External sources; leave empty for a purely local decision
---

# ADR-{{number}}: {{title}}

## Status

{{status}}

## Consequences

### Positive

- {{positive}}

## References

- {{sources}}
```

- `format` is required, and is `markdown`, `text`, `json`, `toml` or `yaml`. It belongs to the template rather than to the call, and it is read when the template is loaded, so a missing or misspelled one is reported there instead of being guessed from the file name. Markdown owns the section rules described below; every other format is rendered literally. `json`, `toml` and `yaml` are parsed after rendering, so an answer that does not produce a valid document is rejected and asked for once more with the parser's own error. `format` is reserved: no field may take its name.
- `type` is `string` (default), `lines` or `enum`. An `enum` needs `values`, and the field's value is validated against them.
- A `lines` field is a newline-separated list. Every item repeats the placeholder's line, so the template's own `- ` prefix becomes the bullet. List markers a model adds anyway are stripped in a Markdown template only; in every other format they are part of the value. `separator` is inserted *between* those repeats — the indentation stays the placeholder line's own, so a JSON array needs `separator: ",\n"` and no trailing comma on the line.
- `optional: true` lets a field come back empty. The placeholder's line disappears, and if that leaves the section with no content its heading disappears too — that is how `sources` above vanishes for a purely local decision.
- Every declared field must appear in the body and every placeholder must be declared; a mismatch is reported when the template is read.
- `values` pins fields Dext owns. Those fields are excluded from the model's contract and win over anything the model returns, which keeps a counter or a module name out of the model's hands. Its entries are validated against the template.
- The call returns `text` and writes nothing. Deciding whether the result becomes a file, and where, is the caller's job: `node.fs.writeFile(path=..., content=created.text)`. A field the file name should follow is the caller's own value — pass it in `values` and reuse the same variable in the path, so the name and the text can never disagree.

The same template contract renders any text format, so a JSON artifact is a template too:

```markdown
---
dext-template:
  format: json
  name: Package name, kebab-case
  version: Version, for example 0.1.0
  keywords:
    type: lines
    separator: ",\n"
    description: One item per line, each written as a quoted JSON string
---

{
  "name": "{{name}}",
  "version": "{{version}}",
  "keywords": [
    {{keywords}}
  ]
}
```

A field value is inserted verbatim where its placeholder sits, so the field's `description` is where a template states the quoting a position needs; the structure around it, including the comma between array items, comes from the template. For a parsed format the render is part of the model's contract: an answer whose render does not parse fails validation and gets the same single repair, with the parser's error as the diagnostic, while `z.toJSONSchema` still sends Codex and Claude the plain field schema. `format` is a reserved option and never a field, so it is never offered to the model.

The call returns the rendered text and nothing else, so the workflow decides what to do with it — here `number` and `slug` come from the workflow's own scope, ride into the template through `values`, and name the file the same way the heading names the record:

```python
created = template(
    input="Record the decision we just made about medoid selection.",
    source=".agents/skills/adr/references/adr-template.md",
    values={"module": "optimize", "number": number, "slug": slug},
    skills=["adr"],
)
node.fs.writeFile(path=f"docs/decisions/{number}-{slug}.md", content=created.text)
```

The call is read-only: it never edits the workspace, so it can always be repaired when its output does not match the template, including a render that does not parse as the declared format. It also never chooses a destination, so the same template can render to any path — and a name that must follow a field is composed by the caller from the value it supplied. Codex and Claude receive the template's fields as their native structured-output schema; DeepSeek Harness has no schema field in ACP, so its answer is validated against the same contract in Dext instead. The template must live inside a trusted workspace, because its content becomes part of the Agent instruction.

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

`ask` is always read-only. `agent` and `plan` use the composer's `Workspace write` or `Full access` scope; in a trusted local workspace, `Workspace write` limits edits to the selected workspace. Code mode has no permission picker, so typed `agent(apply=true)` calls use `Full access` by default. Dext itself can always persist Plan documents in its managed global storage. Both APIs default `workspace` to the current project root.

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

Press Ctrl+C (Cmd+C on macOS) on files in Explorer/Open Editors, an editor tab, or inside a file with no text selected, then Ctrl+V in Dext Input to insert references to the original paths. Multiple files and image files are supported without creating attachments. A visible editor hover keeps VS Code's normal content-copy shortcut. Ctrl+Shift+V pastes the path text as-is. Set `dext.copyFilePathOnCopy` to `false` to restore Explorer's native file copy and the editor's copy-line shortcut.

The editor uses CodeMirror's Python grammar for syntax highlighting, indentation, bracket matching, and native editor behavior. Dext adds API completion, keyword and result-field completion, signature help, hover documentation, exact compiler diagnostics, and a lint gutter.

## Custom APIs and Skills

Custom APIs live in `.dext/api/**/*.dx`. Directory segments become namespaces and each file exports one API through `main()`. The Code input accepts qualified calls such as `playground.verify()` without imports, or imported names such as `verify()`. Inside `.dx` files, custom API calls require explicit imports. Both forms support completion, signature help, and hover information.

```python
# .dext/api/team/analyze.dx -> team.analyze
def main(input: str) -> AskResult:
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
`AskResult`, `PlanResult`, `SkillResult`, `AgentResult`, `TerminalResult`, or `PrintResult`; returning a bare
string, boolean, or list is not supported. Use `return print(text=value)` to
return a summary or collection. `return` works inside `if`, `try`, and `except`;
`finally` runs before the return completes, except on cancellation. A path that
reaches the end without returning fails at runtime. Only `main()` is exported;
helpers cannot be imported from another file. Recursive calls and helper names
that conflict with APIs or imports are rejected. Helper calls, parameters, and
result fields have completion and signature/hover assistance in `.dx` files.

### API diagnostics

Dext validates `.dx` files with the same loader it uses to run them, so an error
surfaces where it is written rather than only when the API is called.

- **Problems** lists every `.dx` error as you type. Each entry carries the file,
  line, column, the stable code (`dext/compile`, `dext/must-return`,
  `dext/unknown-api`, `dext/reassign`, `dext/missing-rule`, `dext/signature`,
  `dext/syntax`, `dext/cycle`, `dext/duplicate-api`, `dext/mcp`, …), and the API
  id it belongs to. Every independent error in a file is reported; one failing
  file no longer hides the others.
- **Dext: Check All APIs** checks the whole project at once, writes the details
  and an `N error / M warning` summary to the **Dext API Check** output channel,
  and fills the same Problems collection so every diagnostic jumps to its file.
- **Dext: Reload APIs** reloads the APIs and reports the same diagnostics.

Checks cover `.dext/api/**/*.dx`, the `dext.apiDirs` roots in
`.vscode/settings.json`, the parameters and result types of loaded MCP tools, and
literal `rules=[...]` paths resolved below `.dext/rules`.

A failed custom API call names its cause instead of reporting only that the API
is unavailable: the file, the function, the reason, and the line, plus why a
declared MCP tool is missing when that is what stopped the file from compiling.
A dependency cycle is named on the APIs that actually form it, not on every
loaded API.

## Conversation history and workflow recording

A conversation can be turned into a starting point instead of being written from scratch: right-click a Dext History entry and choose **Record Conversation as Dext Workflow**. Each successful turn becomes a step, a prompt repeated across turns becomes a `main()` parameter, a confirmation the conversation went through becomes a `ui.confirm` call, and a Code-mode turn is left as a comment. The file is written under `.dext/api` and opened for editing; it is a skeleton to revise, not a finished API.

Dext History is scoped to the current VS Code workspace. Conversations,
favorites, names, and open conversation tabs are restored after restarting VS
Code, but are not shared with other projects.

History turns offer rename, fork, copy as Markdown, and delete from Dext, in that order, in both their toolbar and context menu. The live Conversation toolbar places edit input and retry before these four actions. History's parent conversation toolbar offers continue, rename, fork, copy, favorite, archive, and delete. Shared actions use consistent icons and relative order, with delete last. Turn titles are saved separately from the original input; clearing a title restores its default.

Deleting a turn removes Dext's saved input/output record only. It does not erase CLI messages or undo file changes, and continuing the bound CLI session may still use the deleted turn's context. Dext retains CLI session IDs, including an empty conversation after its final displayed turn is deleted, so it can request the same session on restart. Resuming still requires that provider session to remain available. Retry appends a new execution to the conversation and can repeat write actions.

## Turn and Build review

Every development turn ends with a collapsible **Review** in Output. It lists the files the run touched, classified as created, modified, or deleted, and links each entry to a file reference you can open. The review is attached to one `sessionId + turnId + runId`, so a retry, a fork, or a later Build never inherits the previous acceptance.

A review also carries whatever the run genuinely recorded: script facts with their coverage, semantic suggestions, and Hook results, but only when the Agent or CLI exposed a hook identity and an outcome. Ordinary terminal output and Agent prose are never relabelled as hooks, and a successful tool exit is not reported as business acceptance. When the protocol exposes no hook information, no hook section is rendered at all.

Two presets change the emphasis without changing the operation mode:

- **Engineering review** highlights design decisions, module boundaries, code differences, and dependency changes.
- **Experience acceptance** highlights behavior change, manual scenarios, user feedback, and open acceptance items.

The project sets the default preset in `.dext/project.json`; a per-conversation override wins over it. The effective preset is frozen when you send, so changing the project default afterwards does not rewrite an earlier turn. Ask stays read-only under either preset and produces no acceptance card, as does a turn with no development change.

Accepting a review and adopting a Knowledge draft are separate actions. **Accept review** records your decision on the code for that run and writes nothing to project knowledge. Each pending Knowledge draft has its own **Adopt** action, which writes one long-term object and navigates to it in the Project tab; rejected drafts for the same base version are not offered again.

Plan execution reuses the same component with an additional Build binding: the plan content version plus the Build run ID. Intermediate rounds accumulate into one review and never block continuation. Changes that can be attributed to a task are grouped by task ID, changes owned by more than one task appear under **Shared across tasks**, and anything without a proven owner stays under **Unattributed changes** instead of being guessed from the agent's task checkmarks. The final acceptance waits for your decision rather than letting the Agent spin; later feedback starts a new execution record.

Writing a plan is not implementing it, so a plan-authoring turn produces no implementation review at all.

## Imports, Skills, and rules

`.dx` uses a restricted Python-like syntax. It is parsed by Dext and never starts a Python interpreter. Built-in APIs are always in scope, and `import` refers to custom `.dext/api` files. External files are not read until VS Code marks the workspace as trusted. A nested `agent(...)`, `ask(...)`, or `plan(...)` call may set `skills=["name"]` and `rules=["path.md"]`. Skills are explicit packages, while rules are ordered policy files. Rule paths are resolved only below `<workspace>/.dext/rules`; skill discovery follows the order described below. Dext loads selected skills first and rules last, so the API's narrow rules constrain the general skill workflow. These parameters appear in Dext signatures and completion; their contents are injected into the Agent instruction rather than forwarded as control fields to the provider.

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

The form-level `description` renders Markdown, including headings, lists, code, tables and HTTPS images (`![caption](https://...)`), in both inline and dialog presentations. Images fit the available width and link to the original; failed loads show a fallback link (signed attachment URLs can expire). Raw HTML is displayed as text. Titles, field labels and field descriptions remain plain text. Pass task notes directly as `description`; no extra image field is needed.

Fields have a unique `id`, `label`, optional `description`, `required` (default `True`) and `default`. Without an explicit default, form fields start unanswered. Choice defaults are arrays of option values; input defaults are strings. Default values must satisfy the field contract. Options are nonempty lists of strings or `{value, label, description?}` objects with unique string values. A string option is its own value. `radio` and `checkbox` do not accept `multiple`; only `select` supports it. Dropdowns do not accept custom text. Radio custom text excludes predefined options; checkbox custom text may accompany selections.

Required choices need a selection or allowed custom answer. Required input uses trimmed text to check emptiness, but preserves the submitted text. Optional empty fields are omitted. A yes/no question is an ordinary radio: `selected=["no"]` is a submitted answer, never cancellation or a boolean. Use explicit string comparison in workflow branches.

Shortcuts accept string option lists. `ui.radio` preselects the first item, `ui.checkbox` starts empty and permits an empty submission, and `ui.select` starts at its placeholder and requires a selection. `ui.input` preserves empty strings (`value=""`) on submission; cancellation omits `value`. Cancelled selection shortcuts return their own result type with `selected=[]` and no custom draft. Use `ui.form` to distinguish cancellation from an empty submission.

Cancelling or closing a form returns `status="cancelled", answers={}`; submitting an empty-field form returns `status="submitted", answers={}`. `fields=[]` can express confirmation or information-only dialogs. `show_cancel=False` hides the cancel button, while the close action and stopping the task remain available. Confirm closes as `confirmed=False`. Alert's main button acknowledges; its close button or Escape dismisses. Clicking the backdrop does not dismiss an alert. Acknowledging information does not grant permission for a subsequent operation.

Dropdown Escape closes the option popup first; another Escape closes the container. Radio supports arrow keys, checkboxes support Space, and dialogs restore focus. Pending requests and non-secret drafts survive conversation switches and Webview reconstruction while the host execution remains live. Completed requests show read-only summaries. Historical requests after a host restart are closed.

Workflow and Agent inputs share controls. Native Agent questions still return one answer per question, preserve asynchronous answering and Skip, and clear secret input on submission without storing it in drafts or history. Public fields do not expose secret inputs.

Limits: 32 fields, 200 options per field, 2,000 characters per label/value, 20,000 per text, and 200,000 UTF-8 bytes per form or answer payload. Unsupported fields/attributes, duplicate IDs/options/selections and answers not matching the live request are rejected. Unknown historical results use bounded, escaped read-only text/JSON; they never resume execution. Search, remote options, free creation, virtual lists, conditional fields and nested groups are outside this API version. Ordinary output uses `print`; progress remains in Process/Todo.

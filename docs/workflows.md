# Workflow and API reference

English | [简体中文](workflows.zh-CN.md)

[Back to README](../README.md)

Compose calls in Code mode and save repeated workflows as project APIs. This reference covers the TypeScript module a Code turn runs, built-in APIs, code references, custom APIs, Skills, and conversation history.

[Workflow language](#workflow-language) · [Built-in API](#built-in-api) · [Templates](#templates) · [File and selection references](#file-and-selection-references) · [Custom APIs and Skills](#custom-apis-and-skills) · [Conversation history and workflow recording](#conversation-history-and-workflow-recording) · [Turn and Build review](#turn-and-build-review) · [Imports, Skills, and rules](#imports-skills-and-rules) · [Custom result types](#custom-result-types) · [Execution and previews](#execution-and-previews)

## Workflow language

Input uses Monaco in its existing panel, with the Code selector and footer controls in the same positions. Enter inserts a line in Code and Ctrl/Cmd+Enter runs it. Chat modes retain the configured send behavior; Shift+Enter inserts a line. An open completion list takes priority over sending.

Completion, hover, parameter help and diagnostics come from Monaco's TypeScript service, in Code mode only: Agent, Chat and Plan compose plain text, so a prompt there offers no TypeScript symbols at all. In Code, call trigger characters start parameter help, Escape dismisses it, and Ctrl/Cmd+Shift+Space requests it explicitly. F12 or Ctrl/Cmd+click opens the generated `dext` declaration. The composer paints the active VS Code theme — token colors *and* their italics or bold, names and punctuation included — and a Code turn's source in the conversation is colorized by the same grammar and theme, so the transcript looks like the input it came from. Agent, Chat and Plan prompts stay plain text there too.

File and image chips support atomic selection, deletion and undo. Copying, saved drafts and execution retain complete `@path` source. Long labels are shortened; hover shows the full path. Alt+Enter beside a chip opens the reference, and Ctrl/Cmd+Shift+V pastes literal text. Replace a chip to change its path. Native Find searches ordinary editing text, not the full paths hidden inside chips.

In Code mode, natural language belongs in an API string argument; text that is not valid TypeScript is a compile error.

```ts
import { agent, apply, ask } from "dext";

const analysis = await ask({ input: "Explain this implementation and give refactoring requirements:" });

const preview = await agent({
  input: "Implement the requested refactoring",
  apply: false,
});

// Report conclusions as text without producing a patch.
const summary = await agent({
  input: "Summarize the refactoring plan",
  apply: false,
  patch: false,
});

if (preview.patch) {
  const applied = await apply({ result: preview });
}
```

A Code turn is an ordinary ES module. The whole TypeScript language is available — variables, functions, classes, `if`/`for`/`while`, `try`/`catch`, `async`/`await`, the standard library, and any Node built-in or npm package the workspace can resolve. Top-level `await` works because the entry file is imported as ESM.

Dext runs the file in one long-lived Node child process per workspace, started from VS Code's Electron binary with `ELECTRON_RUN_AS_NODE=1`. Every run re-registers the module loader with a fresh generation, so every workspace module is evaluated again and module-level state cannot leak between runs. Cancelling a turn kills the kernel, and the next run starts a fresh one; a crash in user code cannot take the extension host down. A run may call Dext APIs concurrently — for example with `Promise.all` — and `dext.workflow.maxConcurrency` (default 4, maximum 16) caps how many calls are in flight at once; calls beyond the limit wait in a queue.

A run is not finished while it is waiting for a Dext API. A call written without `await` — `commit()` rather than `await commit()` — still keeps the turn open until it answers, and its failure fails the run, so the agent it started cannot keep working after the panel has stopped listening. Nothing is reported about it: an un-awaited call is ordinary TypeScript, and the types already show that it returns a promise. Write `await` to read the result.

There is no separate workflow language and no interpreter to learn. Files from the old Python-like `.dx` language are not read: migrate one with `node scripts/migrateDxToTs.mjs <file.dx>`, which rewrites what it can and reports what it could not convert for a human to finish.

### Text and value expressions

Expressions are ordinary TypeScript. Dext is not involved: the kernel evaluates the whole module, so any JavaScript expression behaves exactly as it does anywhere else in Node.

| Form | Example | Notes |
| --- | --- | --- |
| Template literal | `` `${answer.text} (${checked.exit_code})` `` | Interpolates any expression |
| Concatenation and arithmetic | `"Review: " + text`, `2 + 3 * 4`, `7 / 2`, `2 ** 8` | `7 / 2` is `3.5`; use `Math.floor(7 / 2)` for integer division |
| Arrays and objects | `["a", "b"]`, `{ id, label }` | Literals, spread and destructuring work normally |
| Indexing and slicing | `text[0]`, `text.slice(1, 4)`, `[...text].reverse()` | `slice`'s end is exclusive; strings are immutable |
| Membership and search | `text.includes("done")`, `list.indexOf(value)`, `"key" in record` | Use whichever the value supports |
| Equality | `a === b`, `a !== b` | Strict equality; `==` applies type conversion |
| Comparison and logic | `a < b`, `a && b`, `a \|\| b`, `!a`, `a ?? b` | Operands follow normal JavaScript rules |
| Optional chaining | `result.patch?.title ?? ""` | Reads a field only when the value is present |

`Math`, `JSON`, `Number`, `String`, `Array`, `Object` and `Date` are the standard built-ins, and there is no Dext-specific list of methods or helpers to learn. A few forms from the removed language have no direct equivalent: use a template literal instead of an f-string or `%` formatting, `Math.floor` instead of `//`, an array instead of a tuple, and `Number(value)` instead of `int(value)` or `float(value)`.

A plain assignment is not a workflow step. Output shows one step per Dext API call; `console.log` and `console.error` add process-output steps that carry text only, with no invocation and no duration.

The old interpreter's resource limits (`while` iteration count, `range` size, folded items, import depth) went with the interpreter. Standard Node and TypeScript limits apply.

## Built-in API

- **Create resource** opens a dedicated tab using the same Conversation and Input layout. Choose **API / MCP / Rule / Skill**, then **Project / Global** (the menu shows the destination directory). Select **New resource** or an existing resource, describe your changes, and review the draft or diff before saving. Saving keeps the tab open for further revisions; changing an existing resource's destination creates a copy. Resource targets, drafts, and conversations are restored from History.
- `ask({ input, workspace?, cli?, model? }) -> AskResult`
- `plan({ input, workspace?, cli?, model? }) -> PlanResult`
- `agent({ input, apply=true, patch=true, workspace?, cli?, model? }) -> AgentResult` — `patch=false` reports conclusions as text without producing a patch.
- `template({ input, source, values={}, workspace?, cli?, model? }) -> TemplateResult` — renders text from a template file ([templates](#templates)).
- `apply({ result }) -> ApplyResult`
- `terminal({ command, cwd=".", env={}, timeout_ms=120000 }) -> TerminalResult` — runs an arbitrary command in the platform shell. `env` supplies string environment variables to that command.
- `skill({ skill, input, workspace?, cli?, model? }) -> SkillResult`
- `mcp.<server>.<tool>({...})` — calls a configured MCP tool.
- `ui.select | ui.radio | ui.checkbox | ui.input | ui.confirm | ui.alert | ui.form` — see [UI interactions and forms](#ui-interactions-and-forms).

Every one of them is an export of the `dext` module:

```ts
import { ask, agent, ui } from "dext";
```

Each call takes exactly one object of named arguments and returns a promise of a JSON-serializable value. `cli`, `model`, `reasoning` and `speed` remain per-call overrides:

```ts
const answer = await ask({ input: "Explain this code", cli: "claude", model: "sonnet" });
```

Node built-ins and workspace packages work directly, because the code runs in a real Node process: `import fs from "node:fs/promises"` and `import path from "node:path"` behave exactly as they do in any other Node program. There is no capability gate and no `node.*` or `js.*` namespace: model-written code in the kernel has the user's full permissions. `terminal` and `apply` have no confirmation dialog; the existing workspace-trust checks remain, but they are no longer a security boundary.

**Dext: View APIs** lists the callable APIs and, beside them, a read-only **node** and **js** reference: one entry per Node built-in module (`node:fs/promises`, `node:path`, `node:url`, …) and per global Node or ECMAScript provides (`process`, `Buffer`, `fetch`, `setTimeout`, `JSON`, `Array`, `Intl`, …). The reference is generated from the declaration files themselves — `@types/node` and TypeScript's own `lib.es*.d.ts` — so every signature is the one the editor and the kernel resolve and every description is the JSDoc the declaration carries; no description is written by hand. Opening an entry lists every member with its signature, parameters, return value and documentation, and the specifier line copies the exact module specifier. These entries document what code may `import` or read as a global; they are not Dext APIs, so they offer no Insert reference action and cannot be called as `node.*` or `js.*`.

`print` is gone. `console.log(...)` and `console.error(...)` are captured as process-output steps and forwarded to the real streams, but they are not Dext results: they carry no invocation and no duration. Return a value, or call an API, when the run needs a typed result.

Values that cross a Dext API boundary must be JSON-serializable, because the kernel and the extension host exchange JSON. Functions, symbols, `Map`, `Set`, `Buffer`, typed arrays, class instances (unless they have a `toJSON()` method) and circular references cannot be sent, and a `Date` is converted to an ISO string. The error names the path and the replacement, so `{ createdAt: new Date() }` becomes an ISO string while `{ cache: new Map() }` is reported at `cache`. User code may use anything inside itself — only what it hands to a Dext API, or returns from an API module, is checked.

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
- The call returns `text` and writes nothing. Deciding whether the result becomes a file, and where, is the caller's job: `fs.writeFile(path, created.text)`. A field the file name should follow is the caller's own value — pass it in `values` and reuse the same variable in the path, so the name and the text can never disagree.

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

```ts
import { template } from "dext";
import fs from "node:fs/promises";

const number = "0081";
const slug = "medoid-selection";

const created = await template({
  input: "Record the decision we just made about medoid selection.",
  source: ".agents/skills/adr/references/adr-template.md",
  values: { module: "optimize", number, slug },
});
await fs.writeFile(`docs/decisions/${number}-${slug}.md`, created.text);
```

The call is read-only: it never edits the workspace, so it can always be repaired when its output does not match the template, including a render that does not parse as the declared format. It also never chooses a destination, so the same template can render to any path — and a name that must follow a field is composed by the caller from the value it supplied. Codex and Claude receive the template's fields as their native structured-output schema; DeepSeek Harness has no schema field in ACP, so its answer is validated against the same contract in Dext instead. The template must live inside a trusted workspace, because its content becomes part of the Agent instruction.

Project APIs live as TypeScript modules under `.dext/api/`. A module is imported by its path below that directory, so `.dext/api/workflow/feature.ts` is `import { main } from "dext/api/workflow/feature"`. Global APIs are stored in Dext global storage and are available in every workspace; a project API with the same id takes precedence. `dext.apiDirs` adds further API directories, and `.dext/api` is always searched first.

A project-local API composes typed MCP, `agent`, and UI calls directly rather than importing intermediate phase APIs. A typical feature workflow reads context, makes a plan, gates on `ui.confirm`, implements, gates again, then validates. Rules live under `.dext/rules/`; every Agent phase declares the ordered rules it uses, and confirmable actions such as code generation and commit stay explicit UI gates.

UI APIs return a result and resume the current workflow; they do not require a separate callback registration. Assign the result when later steps need it:

```ts
import { ui } from "dext";

const confirmation = await ui.confirm({ message: "Apply this change?" });
if (confirmation.confirmed) {
  console.log("Continue");
}
```

The selected value, confirmation state, or input text is also rendered in Output and History after the interaction completes.

Every API output implements the shared `Result` contract. The result kinds are exactly nine — `ask`, `plan`, `agent`, `template`, `apply`, `terminal`, `skill`, `ui` and `mcpRaw` — plus the generated `mcp.<server>.<tool>` kind for structured MCP tools. `ask`, `skill` and `template` are three names for the same `{ kind, text }` shape, and `PatchResult` is not a result kind: it is the shape of `AgentResult.patch`. Result variables and fields such as `AgentResult.patch` are typed by the generated declaration, so completion and hover work in the composer and in `.dext/api/*.ts`. Agent CLIs receive prior results as versioned `dext-result` JSON envelopes instead of interpolated strings.

`ask` is always read-only. `agent` and `plan` use the composer's `Workspace write` or `Full access` scope; in a trusted local workspace, `Workspace write` limits edits to the selected workspace. Code mode has no permission picker, so typed `agent({ apply: true })` calls use `Full access` by default. Dext itself can always persist Plan documents in its managed global storage. Both APIs default `workspace` to the current project root.

```ts
const answer = await ask({ input: "Explain this code:" });
const result = await agent({ input: "Implement the requested change" });
```

`terminal` is available only in a trusted local `file` workspace. Its `cwd` must stay inside the workspace, the timeout is capped at 10 minutes, and captured output is bounded. It runs without a confirmation prompt, so the workflow decides what is safe to run. It returns `TerminalStatus = "succeeded" | "failed" | "timed_out"`; a nonzero exit code is a typed failed result.

`console.log` and `console.error` render values in Dext Output and are forwarded to the process streams; they never write to the integrated terminal. Strings and primitive values are
shown as text. An object or array argument is rendered as indented JSON, with no depth limit, so a logged payload arrives whole instead of as `util.inspect`'s `[Object]`; a value JSON
cannot carry — a `Map`, a cycle — falls back to `util.inspect` at full depth. Format specifiers and the space join are Node's own, so `console.log("label", payload)` still reads as a label
followed by the value.

## File and selection references

Context is attached through readable `@path` tokens inside an API string argument:

- Copying a VS Code selection or choosing a file or folder inserts an `@workspace/path` token; a selection carries its range as `#Lstart,startChar-Lend,endChar`.
- A directory token ends with a slash and references the directory without reading or expanding its contents.
- The token is rendered as an atomic Chip, can be removed atomically, and participates in undo/redo. Existing legacy marker, f-string, and nested-quote reference forms are migrated to this representation when loaded.

Selecting workspace code shows **Add to Dext** in a floating editor hover near the active selection cursor after a brief pause. The hover overlays the editor without adding a row or shifting code, and keeps keyboard focus in the editor. Click it to add the selected file range to Input. VS Code controls the hover's appearance and placement; symbol information may share the same hover. Toggle `dext.selectionActions.enabled` in Settings to show or hide this action immediately. Editor, file list, and file tab context menus use the same **Add to Dext** label and remain available when the selection action is disabled.

Press Ctrl+C (Cmd+C on macOS) on files in Explorer/Open Editors, an editor tab, or inside a file with no text selected, then Ctrl+V in Dext Input to insert references to the original paths. Multiple files and image files are supported without creating attachments. A visible editor hover keeps VS Code's normal content-copy shortcut. Ctrl+Shift+V pastes plain text rather than a reference. VS Code keeps its own copy wherever it has one: an Explorer copy still pastes the files themselves — into this window's Explorer or another one — and a file editor with nothing selected still copies the line. Only Open Editors and the editor tab area, which have no copy shortcut of their own, receive the path text. Set `dext.copyFilePathOnCopy` to `false` to stop staging file paths on copy.

Selecting terminal output and pressing Ctrl+Shift+C (Cmd+C on macOS) copies it and attaches that output to Dext Input. Ctrl+C is left to the shell, so it still interrupts the running command.

The token stays readable text in the submitted input, and Dext never inlines file contents into the prompt: the Agent reads the referenced file itself. `ask`, `agent`, `plan` and `template` all accept these tokens in `input`.

The composer is Monaco's TypeScript editor, so highlighting, indentation, bracket matching and native editing behavior come from the TypeScript grammar. Code mode is plain TypeScript and nothing more: Dext adds the generated `dext` declaration and the workspace's own `.dext/api` modules as extra libraries, resolved by the same `dext/api/*` mapping the generated project gives VS Code, and then completion, auto-import, signature help, hover, Go to Definition and diagnostics are the editor's own. `import { main } from "dext/api/git/commit"` therefore resolves and type-checks in the composer, and its import specifier and named exports complete like any other module's. An export that is not imported yet is completed together with the import that binds it — typing `ask` offers `ask` with `import { ask } from "dext";`, and typing `commi` offers the workspace API's own `commit` with its `import { commit } from "dext/api/git/commit";`; inside `import { … } from "…"` the module's exports are offered without any edit. The names are read out of the declaration and the API sources, never guessed from a name's shape: `git` is a directory, not an export, so typing it offers nothing and `.dx`-style qualified calls are not translated. A run that still used one of those names without importing it fails with the import to write: `git is not defined` is followed by `use: import { main as commit } from "dext/api/git/commit";`.

## Custom APIs and Skills

Custom APIs live in `.dext/api/**/*.ts`. Directory segments become namespaces and each file is an ordinary ES module:

```ts
// .dext/api/team/analyze.ts -> "dext/api/team/analyze"
import { ask, type AskResult } from "dext";

export async function main(input: string): Promise<AskResult> {
  return await ask({ input });
}
```

Import one by its path below `.dext/api`:

```ts
import { main as analyze } from "dext/api/team/analyze";

const answer = await analyze("Explain task filtering and its tests");
console.log(answer.text);
```

The module exports `main` as a convention Dext looks for when the module is itself the run's entry point; an importer decides how to call it. The export is not special otherwise — anything the module exports is available to the importer.

Split a longer API into helpers the ordinary way:

```ts
// .dext/api/playground/develop.ts
import type { TerminalResult } from "dext";
import { main as verify } from "dext/api/playground/verify";

function report(checked: TerminalResult): void {
  if (checked.status !== "succeeded") console.error(checked.stderr);
  else console.log(checked.stdout);
}

export async function main(): Promise<void> {
  report(await verify());
}
```

Helpers are ordinary functions: a module may export as many values as it likes, another module imports any of them, and recursion, classes, generics and npm packages all work. There is no required result type — `main` may return a Dext result, a plain value, or nothing. Completion, signature help and hover in `.dext/api/*.ts` come from VS Code's TypeScript service against the generated declaration.

### Generated types

Dext generates the `dext` project a workspace's editor reads, and the workspace commits it. It is written on every API reload, and every path in it is relative, so the same files work on another machine and in CI:

- `.dext/api/dext.d.ts` — the `dext` module: every built-in API, the `ui` group, the `mcp` group, every result interface, the JSON-boundary rule, and the MCP tools this project's own `.dext/mcp/*.jsonc` manifests declare. **Open built-in API definition** and F12 open this file.
- `.dext/tsconfig.json` — a strict `nodenext` project that maps `dext` at `./api/dext.d.ts` and `dext/api/<id>` at the API module itself (`dext/api/team/analyze` names `api/team/analyze.ts`, the same search order the kernel loader uses, including any directory the project adds to `apiDirs`), and includes `api/**/*.ts`. It sets `erasableSyntaxOnly: true`, so syntax Node's type stripping cannot erase — `enum`, `namespace`, parameter properties and decorators — is an editor error; the kernel refuses it with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
- `.dext/package.json` — marks that directory as ESM, so the TypeScript service treats `.dext/api/*.ts` the way the kernel loads it, top-level `await` included, and declares the `@types/node` those files compile against. It belongs to Dext; do not put a `package.json` of your own there.

All three are generated: edit one and the next reload puts it back, and `npm run check`'s `--workspace . --check` proves the files this repository commits still match the registry. A workspace that never writes an API module gets none of them. Two API sources stay untyped because a committed file cannot name them: the `dext.apiDirs` setting and APIs in Dext's global storage are machine-local, and a global MCP manifest is likewise absent from the declaration (see [MCP configuration](mcp.md)).

Node built-ins are ordinary imports — `import fs from "node:fs/promises"`, the way a custom API reads or writes a file — and it takes two steps before the editor agrees. Install the declared definitions once with `npm install` in `.dext`. The project also sets `types: []`, so that an unrelated `@types/*` package in the workspace cannot leak its globals into these files; that keeps `@types/node`'s ambient modules out of the program until a file asks for them, so a file that imports a Node built-in starts with `/// <reference types="node" />` — one such file is enough, because the types it pulls in belong to the whole program, and a project that imports no Node built-in needs neither the line nor the install. Declare dependencies of your own in a manifest outside `.dext`: Dext owns this one, and the next reload drops anything added to it.

The build also writes `dist/dext.d.ts` — the same declaration without any project's MCP tools. It is not read at runtime: `npm run check` runs `generate:dext-types --check` against it to prove the built-in surface still matches the registry, and it ships in the VSIX so the API surface can be inspected from the package.

VS Code's own TypeScript service then gives completion, hover, F12 and diagnostics in `.dext/api/*.ts`, and Monaco is handed the same declaration in memory for the composer. There is no separate API checker: **Dext: Reload APIs** refreshes the declaration and reloads the registry.

## Conversation history and workflow recording

A conversation can be turned into a starting point instead of being written from scratch: right-click a Dext History entry and choose **Record Conversation as Dext Workflow**. Each successful turn becomes a step, a prompt repeated across turns becomes a `main()` parameter, a confirmation the conversation went through becomes a `ui.confirm` call, and a Code-mode turn is left as a comment. The file is written under `.dext/api` and opened for editing; it is a TypeScript skeleton to revise, not a finished API.

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

Built-in APIs are imported from the `dext` module and are always available; `import` is ordinary ESM, so it also brings in Node built-ins, workspace files, custom APIs as `dext/api/<id>`, and npm packages. External files are not read until VS Code marks the workspace as trusted.

Skills are explicit packages. `skill({ skill: "name", input })` loads the named `SKILL.md` and injects it into the current Agent task. Discovery order is `<workspace>/.dext/skills`, then the project Skill directories in **Project > Overview > Project configuration**, then Dext global storage; legacy `dext.skillDirs` remains a fallback until project values are saved, and earlier directories win duplicate names. `create` can place a skill in either scope.

Rules are ordered policy files under `.dext/rules/`, and a rule path is resolved only below that directory. `.dext/rules/plan.md` replaces the default plan-document instruction used by Plan mode. `agent`, `ask`, `plan` and `template` can also be scoped with `skills` and `rules` for a single call — `await agent({ input: "…", rules: ["review.md"] })`. They are `internal` because they are never forwarded to a provider as control fields, and the generated declaration still lists them on exactly these four APIs, because a caller writes them. Dext loads selected skills first and rules last, so the call's narrow rules constrain the general skill workflow, and their contents are injected into the Agent instruction. `ui.*` waits for a semantic user answer and resumes the same workflow.

## Custom result types

Every value a Dext API returns is one of the declared result types: `AskResult`, `PlanResult`, `AgentResult`, `TemplateResult`, `ApplyResult`, `TerminalResult`, `SkillResult`, the `Ui*Result` variants, and `McpRawResult`. A custom API returns one of them like any other value, and there is no per-file result declaration to write. `ask`, `skill` and `template` share the `{ kind, text }` shape, and `PatchResult` is the type of `AgentResult.patch` rather than a result kind of its own.

Declare your own interfaces and types freely for the values a module uses internally — they are ordinary TypeScript. Only the values that cross a Dext API boundary must stay JSON-serializable, and only the declared result types can be handed to `apply`:

```ts
import type { AgentResult } from "dext";

interface ReviewSummary {
  title: string;
  files: string[];
}

function summarize(result: AgentResult): ReviewSummary {
  return {
    title: result.summary ?? result.text,
    files: (result.files ?? []).map((file) => file.uri),
  };
}
```

## Execution and previews

A Code run executes immediately in the Node kernel. Every Dext API call is dispatched to the extension host, where the same typed contract and result validation apply whether or not an Agent profile is selected. `terminal`, `apply` and `ui.*` are always handled by Dext itself.

Without an Agent profile, `ask`, `plan` and `agent` return a deterministic echo of their input and make no workspace changes, and `skill` and `template` report that they need a profile. A preview does not mean an AI task has run. With a profile selected, the call goes to the selected CLI and its structured output is validated before display.

## Continuing a failed Code run

A failed Code turn offers **Continue**. Dext recorded every Dext API call the failed attempt made — in order, with the arguments it used — and Continue replays them: a call that still matches returns the response it produced before, so the work that already succeeded is not repeated, and the run resumes at the first call that is new. `console.log`/`console.error` output is not a recorded call and never affects the alignment.

Replay is exact or it stops. Dext compares the call index, the method and the arguments; the first difference means the code — or a value the recording cannot see, such as `Date.now()`, `Math.random()`, an environment variable or a file read outside a Dext call — sent the second attempt down another path. Rather than attaching an old response to a different call, the run stops with an explicit "the recorded calls no longer line up" error and the turn can be retried from the start. A stopped turn is not a continuation point: Stop ends it.

Old `.dx` checkpoints from earlier versions are not read and cannot be resumed; Code files and their turns start fresh.

## UI interactions and forms

All UI calls wait for the user's answer and produce one workflow step. `presentation: "inline"` places the interaction above Process in its conversation; `"dialog"` uses a dialog. Waiting pauses only the calling workflow. Stopping the task interrupts the wait and skips subsequent steps.

```ts
ui.select(options: { label: string; options: string[]; multiple?: boolean; placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiSelectResult>
ui.radio(options: { label: string; options: string[]; allow_custom?: boolean; custom_placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiRadioResult>
ui.checkbox(options: { label: string; options: string[]; allow_custom?: boolean; custom_placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiCheckboxResult>
ui.input(options: { label: string; placeholder?: string; multiline?: boolean; presentation?: "inline" | "dialog" }): Promise<UiInputResult>
ui.confirm(options: { message: string; confirm_label?: string; cancel_label?: string; presentation?: "inline" | "dialog" }): Promise<UiConfirmResult>
ui.alert(options: { message: string; acknowledge_label?: string; presentation?: "inline" | "dialog" }): Promise<UiAlertResult>
ui.form(options: { title: string; fields: UiField[]; description?: string; submit_label?: string; cancel_label?: string; show_cancel?: boolean; presentation?: "inline" | "dialog" }): Promise<UiFormResult>
```

| API / field | Control | Result payload |
| --- | --- | --- |
| `ui.select` / `select` | Collapsed single or multiple dropdown | `type: "select"`, `selected` array |
| `ui.radio` / `radio` | Expanded mutually exclusive options | `type: "radio"`, `selected` array and optional `custom` |
| `ui.checkbox` / `checkbox` | Expanded independent checkboxes | `type: "checkbox"`, `selected` array and optional `custom` |
| `ui.input` / `input` | Single or multiline text | `type: "input"`, string `value` |
| `ui.confirm` | Confirm / cancel buttons | `type: "confirm"`, boolean `confirmed` |
| `ui.alert` | Acknowledge information | `type: "alert"`, `status: "acknowledged"` or `"dismissed"` |
| `ui.form` | Submit all fields together | `type: "form"`, `status: "submitted"` or `"cancelled"`, `answers` keyed by field ID |

API results include `kind: "ui"`. Field answers inside `answers` contain only `type` and their value properties. A field description creates no interaction itself; never put executing API calls inside `fields`.

```ts
import { ui, type UiField } from "dext";

const fields: UiField[] = [
  { id: "environment", type: "select", label: "Environment", options: [
    { value: "dev", label: "Development", description: "Local environment" },
    { value: "test", label: "Testing" }
  ] },
  { id: "approach", type: "radio", label: "Approach", options: ["inspect", "change"], allow_custom: true },
  { id: "checks", type: "checkbox", label: "Checks", options: ["types", "tests", "build"], required: false },
  { id: "details", type: "input", label: "Details", multiline: true, required: false },
  { id: "run_tests", type: "radio", label: "Run tests?", options: [
    { value: "yes", label: "Yes" }, { value: "no", label: "No" }
  ] }
];
const reply = await ui.form({ title: "Settings", fields, submit_label: "Apply settings" });
if (reply.status === "submitted") {
  if (reply.answers["run_tests"]?.selected?.[0] === "yes") {
    console.log("Run the selected checks");
  }
}
```

The form-level `description` renders Markdown, including headings, lists, code, tables and HTTPS images (`![caption](https://...)`), in both inline and dialog presentations. Images fit the available width and link to the original; failed loads show a fallback link (signed attachment URLs can expire). Raw HTML is displayed as text. Titles, field labels and field descriptions remain plain text. Pass task notes directly as `description`; no extra image field is needed.

Fields have a unique `id`, `label`, optional `description`, `required` (default `true`) and `default`. Without an explicit default, form fields start unanswered. Choice defaults are arrays of option values; input defaults are strings. Default values must satisfy the field contract. Options are nonempty lists of strings or `{value, label, description?}` objects with unique string values. A string option is its own value. `radio` and `checkbox` do not accept `multiple`; only `select` supports it. Dropdowns do not accept custom text. Radio custom text excludes predefined options; checkbox custom text may accompany selections.

Required choices need a selection or allowed custom answer. Required input uses trimmed text to check emptiness, but preserves the submitted text. Optional empty fields are omitted. A yes/no question is an ordinary radio: `["no"]` is a submitted answer, never cancellation or a boolean. Use explicit string comparison in workflow branches.

Shortcuts accept string option lists. `ui.radio` preselects the first item, `ui.checkbox` starts empty and permits an empty submission, and `ui.select` starts at its placeholder and requires a selection. `ui.input` preserves empty strings (`value: ""`) on submission; cancellation omits `value`. Cancelled selection shortcuts return their own result type with `selected: []` and no custom draft. Use `ui.form` to distinguish cancellation from an empty submission.

Cancelling or closing a form returns `status: "cancelled", answers: {}`; submitting an empty-field form returns `status: "submitted", answers: {}`. `fields: []` can express confirmation or information-only dialogs. `show_cancel: false` hides the cancel button, while the close action and stopping the task remain available. Confirm closes as `confirmed: false`. Alert's main button acknowledges; its close button or Escape dismisses. Clicking the backdrop does not dismiss an alert. Acknowledging information does not grant permission for a subsequent operation.

Dropdown Escape closes the option popup first; another Escape closes the container. Radio supports arrow keys, checkboxes support Space, and dialogs restore focus. Pending requests and non-secret drafts survive conversation switches and Webview reconstruction while the host execution remains live. Completed requests show read-only summaries. Historical requests after a host restart are closed.

Workflow and Agent inputs share controls. Native Agent questions still return one answer per question, preserve asynchronous answering and Skip, and clear secret input on submission without storing it in drafts or history. Public fields do not expose secret inputs.

Limits: 32 fields, 200 options per field, 2,000 characters per label/value, 20,000 per text, and 200,000 UTF-8 bytes per form or answer payload. Unsupported fields/attributes, duplicate IDs/options/selections and answers not matching the live request are rejected. Unknown historical results use bounded, escaped read-only text/JSON; they never resume execution. Search, remote options, free creation, virtual lists, conditional fields and nested groups are outside this API version. Ordinary output uses `console.log`; progress remains in Process/Todo.

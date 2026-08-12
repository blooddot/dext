# Dext

Dext is a first-version typed AI method environment for Visual Studio Code. It treats commands and skills as callable definitions instead of free-form prompts. Code mode invokes those definitions directly; Chat mode deterministically compiles into the same invocation AST and runtime.

This version is intentionally offline. It does not connect to a model, request credentials, run workspace scripts, or apply changes to files.

## Features

- Activity Bar sidebar with Code and Chat input modes.
- A compact method-call DSL with completion, diagnostics, and signature help.
- Built-in, global, and project method sources with deterministic precedence.
- Declarative project configuration at `.dext/methods.json`.
- Workspace Trust gating for all external method configuration.
- Immutable code references containing URI, range, document version, SHA-256 hash, and content.
- Context-aware editor copy: Ctrl+C or Cmd+C keeps the exact clipboard text while staging the selected code for Code or Chat.
- Inline Chat attachments from captured selections, workspace file picking, and Explorer drag-and-drop.
- A stable Dext IR and Ax adapter that keeps Ax implementation classes out of configuration.
- Independent renderers for `text`, `code`, `review`, `plan`, and `patch` results.

## DSL

One input contains exactly one method invocation with named arguments:

```dext
core.code.review(
  target: @selection,
  focus: "correctness"
)
```

Supported values are strings, numbers, booleans, arrays, and these context references:

```dext
@selection
@activeFile
@file("src/extension.ts")
@file("src/extension.ts#L10,1-L18,8")
@symbol("DextRuntime")
```

Code and Chat share one execution pipeline:

```text
Code DSL  -- parse/type-check --+
                                 +-- Invocation AST -- Dext Runtime -- Ax contract -- typed result
Chat text -- deterministic map --+
```

Chat currently maps to `core.chat.respond(message: ...)`. Its compiler is isolated so a future intent compiler can replace it without changing the runtime contract.

With `dext.captureSelectionOnCopy` enabled (the default), copying a nonempty editor selection also captures its source URI, range, version, hash, and content. Pasting that unchanged text into Dext Chat inserts a removable attachment token at the caret instead of duplicate source text. In Code mode the same paste inserts a readable `@file("path#Lstart,column-Lend,column")` reference; pasting inside an existing `@file("")` inserts only its payload. Files can also be attached at the Chat caret with the paperclip button or by dragging workspace files into the composer. Disable the setting to restore VS Code's native copy behavior for selections.

## Method configuration

Project methods live in `.dext/methods.json`. An optional trusted global file can be selected with `dext.globalMethodsFile`.

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
        { "name": "goal", "type": "string", "required": true },
        {
          "name": "areas",
          "type": "enum",
          "values": ["runtime", "editor", "tests"],
          "multiple": true
        }
      ],
      "output": { "kind": "plan" },
      "executor": { "kind": "deterministic", "handler": "outlinePlan" }
    }
  ]
}
```

Supported field types are `string`, `number`, `boolean`, `enum`, and `context`. Set `multiple` for array input. External definitions can select only deterministic handlers compiled into Dext; configuration cannot contain JavaScript or shell commands.

Resolution order is `project > global > builtin` for identical method IDs. External files are not read until VS Code marks the workspace as trusted. `@file` cannot escape the workspace root.

## Built-ins

- `core.chat.respond`: deterministic Chat-mode target.
- `core.code.review`: resolves code and returns a structured review shell.
- `core.context.snapshot`: reusable Skill that renders a resolved `CodeRef`.

The review executor confirms the typed pipeline and context boundary only. Semantic code review requires a future model adapter.

## Architecture

- `src/core/types.ts`: stable Dext IR and result contracts.
- `src/core/dsl.ts`: tokenizer and parser.
- `src/core/languageService.ts`: completion, diagnostics, and signatures.
- `src/core/contextResolver.ts`: immutable context snapshots.
- `src/core/axAdapter.ts`: Ax/Zod/JSON Schema boundary.
- `src/core/runtime.ts`: deterministic executor allowlist.
- `src/application.ts`: VS Code-neutral features composed for the host.
- `src/sidebarProvider.ts`: typed Webview message bridge.

Ax is used to build structured input/output signatures. Zod is the runtime source of truth and generates JSON Schema contracts. No Ax class or provider setting appears in method configuration.

## Development

Requirements: Node.js 20 or newer and VS Code 1.105 or newer.

```bash
npm install
npm run check
```

Open the repository in VS Code and run the `Run Dext Extension` launch configuration. The build copies Codicons into `dist` so the Webview has no CDN dependency.

Useful commands:

```bash
npm run build
npm run lint
npm test
npm run test:host
```

`test:host` uses an installed VS Code build for an activation/sidebar smoke test. Set `VSCODE_EXECUTABLE_PATH` when VS Code is installed outside its standard platform location, or set `DEXT_TEST_DOWNLOAD=1` to use an isolated downloaded build.

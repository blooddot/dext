# Project knowledge and review

Project configuration lives in **Project > Overview > Project configuration**. It includes the default Review preset, the workspace Plan directory, and project-relative extra API, Skill, and MCP directories. **Project settings** contains the Standard, Deep, or Whole evidence depth; expand its Advanced section for file and character limits and workspace-relative scope patterns. Saving persists the values in `.dext/project.json` and applies them to new turns, Plan documents, API/Skill/MCP reloads, initialization, and diagram generation. Before a project saves its own value, the old VS Code settings remain a compatibility fallback. Whole still has a 1,000-file limit, and blank evidence numeric fields follow the selected depth.

English | [简体中文](project-development.zh-CN.md)

[Back to README](../README.md)

Dext keeps two kinds of understanding separate. **Project knowledge** is long-lived and belongs to
the repository. **Conversation review** describes one run and is never written into the project.

[Project files](#project-files) · [Knowledge dimensions](#knowledge-dimensions) ·
[Conversation review](#conversation-review) · [Review presets](#review-presets) ·
[Editor tabs](#editor-tabs) · [Explicit initialization](#explicit-initialization) ·
[Diagrams and Archify](#diagrams-and-archify) · [Checks](#checks)

## Project files

Project data lives under `.dext/` in the workspace:

| Path | Contents |
| --- | --- |
| `.dext/project.json` | Schema version, optimistic `version`, default review preset, project paths (`planDirectory`, `apiDirs`, `skillDirs`, and `mcpDirs`), evidence settings and AI CLI selection. Legacy `scan` and engine-preference fields stay readable and are preserved on write, but are no longer used. |
| `.dext/project-intent.json` | AI-generated project brief and semantic knowledge from initialization |
| `.dext/objects/<id>.json` | One accepted long-term object per file |
| `.dext/architecture.json` | Declared design decisions and architecture rules. Rules are evaluated against the saved diagram they name, never against a source scan. |
| `.dext/diagrams/<id>.json` | Canonical AI-generated diagram IR (renderer-neutral, one file per diagram) |

`ProjectStore` reads and writes these files through a small file host, so the same logic runs in the
extension, a worker, or an in-memory test double. Every write takes the expected `version`; a
concurrent change is reported as `{ status: "conflict" }` instead of overwriting. A missing or
corrupt `project.json` falls back to defaults so development is never blocked.

`ProjectObjectReference` stores a stable `objectId`. Renaming an object keeps its id and remembers
the previous names as aliases, so references, links, and tests survive the rename.

## Knowledge dimensions

A project object carries four independent dimensions. They are never collapsed into one status.

- **Source** (`source`): `code`, `ai`, or `user`.
- **Confirmation** (`confirmation`): `draft`, `accepted`, or `rejected` — a user decision.
- **Validity** (`validity`): `current`, `needs_verification`, `stale`, or `conflicted` — re-checking
  against the code.
- **Ownership** (`ownership`): `owned`, `shared`, `candidate`, or `unassigned`.

Accepting an AI suggestion sets `confirmation: "accepted"` but keeps `validity:
"needs_verification"`, because accepting a suggestion is not the same as confirming it against the
current code. `validateProjectObjects` reports duplicate ids, duplicate names or aliases, and
dangling `relatedIds`.

The legacy `status` field is still parsed. `normalizeProjectObject` migrates it, mapping
`accepted`, `stale`, and `conflicted` to `confirmation: "accepted"` and filling the remaining
dimensions. New code writes the four dimensions only.

## Conversation review

`TurnReview` is keyed by `sessionId + turnId + runId`, so feedback can never land on another run,
an older attempt, or a different Plan Build. A review also records the `projectVersion`,
`planVersion`, and `buildRunId` it was produced against, and `reviewRepresentsVersion` refuses a
conclusion that an older project version produced.

`TurnReviewStore` keeps reviews in memory with oldest-first eviction at a bounded size, and
`TurnReviewController` exposes the actions the host needs: `find`, `submitFeedback` (returning
`not_found`, `stale`, `accepted`, or `rejected`), `diffTargets`, `acceptanceCard`, and
`adoptKnowledgeSuggestion`. Accepting code and adopting a knowledge suggestion are separate
decisions: the latter refuses a stale `baseVersion`.

### Turn review view

`renderTurnReview` produces a collapsible region. A pure Ask turn, or a turn with no development
change and nothing to accept, produces no acceptance card. Hook results are only shown when a
provider explicitly reported them; an unknown or failed hook is never rendered as a pass.

### Plan review

`buildPlanReview` accumulates every round of one Build. `associatePlanChanges` groups changes by
task using explicitly recorded associations only — a change owned by more than one task becomes a
shared change, and anything without an association stays unattributed. Dext never infers file
ownership from the agent's task checkmarks. `finalizePlanReview` records the build-level decision;
intermediate task reviews never block continuation, and only the final Review waits for the user.

## Review presets

Two presets change what a review emphasizes, independently of Ask/Agent/Plan/Code:

- **engineering** emphasizes design decisions, module boundaries, and the reasons behind the change.
- **experience** emphasizes behavior changes, feedback, and manual verification.

`resolveReviewPreset` picks the preset from the project default and an optional per-run override. In
Ask mode the result is read-only and the captured time is recorded.

## Editor tabs

Project, API, Global Resources, and History open as editor tabs and share one layer:

- `editorTabTypes` defines the tab kinds, view types, titles, pages, and stable key format.
- `editorTabState` validates persisted state; an unknown page falls back to the kind's default.
- `editorTabManager` creates at most one panel per key, supports reveal/close, and uses an injected
  host so it can be tested without VS Code.
- `editorTabSerializer` registers a `WebviewPanelSerializer`-compatible restore path with a claim
  guard, so a serializer restore and a proactive restore never double-open the same tab.

The Project tab exposes **Overview**, **Knowledge**, and **Diagrams**. The page key stays `architecture`
so restored tabs keep working, while the visible name describes what the page contains. There is
deliberately no Hooks, Review, scan-folder or renderer-preference control, and no run metadata is
loaded into it.

## Explicit initialization

Opening, restoring, switching or refreshing the Project tab only reads saved `.dext` data. Dext never
enumerates source files, runs a parser, calls AI, or writes `.dext` in the background. Source text is
read only after the user chooses **Initialize project knowledge** or generates a diagram.

The initialization service uses three phases:

1. **Preparing** — read a bounded evidence package: README/documentation, manifests and the necessary
   source text, capped by file count, per-file size, total characters, exclusion rules, path validation
   and secret redaction. No AST, import graph or language parser is constructed.
2. **Generating** — the selected Project AI CLI returns one strict JSON document containing the Project
   Intent and zero or more diagrams. Evidence, stable-id references and kind-specific diagram semantics
   are validated against the exact bounded input before anything is saved. Codex and Claude receive the
   response schema through their own structured-output channel (`--output-schema` / `--json-schema`), so
   the answer is constrained by the provider rather than only asked for in the prompt; a CLI that refuses
   the schema, or fails to start, falls back to the conversation transport for that attempt and reports
   why. The shared ax predictor owns the answer envelope and one bounded repair attempt: the strict
   contract parse and the evidence checks run as its validation step, a rejected answer is re-prompted
   with those diagnostics, and a key the contract never declares is dropped before validation instead of
   failing an otherwise verifiable run. DeepSeek Harness has no schema field in ACP, so it always uses the
   conversation transport.
3. **Saving** — the intent and every diagram are written first; `.dext/project.json` is marked
   `initialized` only after all writes succeed. A failed or cancelled run never reports success, and a
   late response from an older run cannot overwrite a newer state.

A project with no valid saved intent shows **Not initialized** and an explicit initialization entry.
A legacy `initialized` flag, old scan data or an engine-preference file alone never counts as success.
Running, failed, cancelled, and initialized-but-missing-diagram states are shown separately. On restart,
state is recovered from the saved intent, saved diagrams and the initialization record: a project with
only diagrams keeps them viewable and reports that the knowledge model still needs initialization.

## Diagrams and Archify

Project's semantic model and `ProjectDiagram` IR are the source of truth. One pinned engine renders
them: Archify `2.17.0-dev.1+d673e830`, shipped in `vendor/project-diagrams/archify` and located from
`context.extensionUri` at runtime (never from `process.cwd()`). No skill installation, Python runtime
or online rendering service is required.

Five kinds share the common node/relation/evidence structures and add optional, renderer-neutral
semantics:

| Kind | Optional semantic structures |
| --- | --- |
| Architecture | Boundaries that group existing nodes; dependency direction on relations |
| Workflow | Lanes and `laneId` on nodes, explicit relation order, branch conditions, exception paths, phases/groups for grouped layout |
| Sequence | Ordered participants and call/return messages covering every relation |
| Data flow | Two to five stages with `stageId` on every node |
| Lifecycle | Explicit initial/normal/terminal states, events, conditions and transitions |

Archify conversion maps each kind to its own upstream schema (including `data_flow → dataflow` and
workflow schema v2 columns 0–5), keeps a bidirectional Project-id/Archify-id mapping, passes source
evidence where the upstream schema supports it, and repairs layout-only diagnostics within a bounded
number of attempts. Semantic diagnostics are returned with their messages instead of being rewritten.

### Declared architecture rules

`.dext/architecture.json` may declare rules over the **stable Project node ids** of one saved diagram,
so a rule keeps working when Archify ids or the layout change:

```json
{
  "schemaVersion": 1, "version": 0, "updatedAt": 0,
  "decisions": [],
  "diagramId": "architecture",
  "rules": [
    { "id": "no-ui-db", "type": "deny", "from": "ui", "to": "db", "reason": "The UI writes through the API." },
    { "id": "api-only", "type": "allow", "from": "api", "to": "db", "reason": "Only the API may reach the database." },
    { "id": "acyclic", "type": "no_cycles", "from": "*" }
  ]
}
```

`deny` flags a relation that exists, `allow` every relation leaving `from` that does not go to `to`,
and `no_cycles` any dependency cycle. The Diagrams page lists the rules and the violations the saved
diagram currently has; when rules exist but no diagram can be evaluated (`diagramId` is missing while
several architecture diagrams are saved, names a diagram that is not saved, or no architecture
diagram exists), the page says so instead of guessing. A rule typo makes the file unusable and the
page reports the defaults, so a broken rule is never silently ignored.

The **Diagrams** page embeds the complete Archify HTML in a sandboxed iframe, so the native visuals,
search, zoom and exploration controls stay available. The parent page owns the VS Code API; iframe
messages are validated by source window and session token, and actions are addressed by `diagramId`
plus semantic version. The page provides diagram selection, generate/update, refresh, export and
fullscreen; validation, version and evidence coverage details live in a collapsed section.

Exports are **HTML** and **SVG** only, and both use the currently displayed successful render. HTML can
be opened standalone; SVG is the native serialization of the live viewer (styles, fonts and background
preserved) captured through the bridge, then saved by the extension host. If a newer render fails, the
page shows the same diagram's last successful version and labels which version is displayed, so
exporting matches what is on screen. Switching diagrams, closing the page, or starting a newer
operation cancels stale work.

## Checks

```bash
npm run check      # tsc --noEmit, eslint, and the production build
npm run test:host  # VS Code activation smoke test (see README for environment requirements)
```

Browser checks run in a local Chromium or Edge, and are kept out of `npm run check` so the standard
gate does not depend on one being installed:

```bash
npm run check:ui                        # all four checks below
node scripts/checkComposerLayoutUi.mjs  # composer attachment growth, footer alignment, narrow viewports
node scripts/checkStreamJumpUi.mjs      # jump-to-latest control never covers the conversation scrollbar
node scripts/checkEditorTabsUi.mjs      # shared editor shell, Project pages, CSP and themes
node scripts/checkProjectDiagramsUi.mjs # five native diagram kinds, uninitialized/empty states, bridge, exports
```

Unit tests for the project layer run with `npx vitest run test/project*.test.ts test/editorTab*.test.ts test/turnReview*.test.ts`.
`scripts/assertWebviewAssets.mjs` additionally proves from the esbuild dependency manifest that the
runtime bundle contains neither the TypeScript compiler nor the removed scan/engine implementations,
that the Archify entry point, five schemas and five renderers the adapter names are present, and that
`vendor/project-diagrams/drawio` is not packaged. The rest of the vendored runtime is distributed
because `.vscodeignore` does not exclude `vendor/**`.

# Project knowledge and review

English | [简体中文](project-development.zh-CN.md)

[Back to README](../README.md)

Dext keeps two kinds of understanding separate. **Project knowledge** is long-lived and belongs to
the repository. **Conversation review** describes one run and is never written into the project.

[Project files](#project-files) · [Knowledge dimensions](#knowledge-dimensions) ·
[Conversation review](#conversation-review) · [Review presets](#review-presets) ·
[Editor tabs](#editor-tabs) · [Architecture scanning](#architecture-scanning) ·
[Checks](#checks)

## Project files

Project data lives under `.dext/` in the workspace and is owned by three files:

| Path | Contents |
| --- | --- |
| `.dext/project.json` | Schema version, optimistic `version`, default review preset, knowledge settings |
| `.dext/objects/<id>.json` | One accepted long-term object per file |
| `.dext/architecture.json` | Declared module relations, rules, and design decisions |

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

The Project tab exposes only **Overview**, **Knowledge**, and **Architecture**. There is deliberately
no Hooks, Review, or task-execution page, and no run metadata is loaded into it.

## Architecture scanning

`runArchitectureScan` / `startArchitectureScan` bound a scan by file count, file size, and duration,
and report coverage for skipped files. Cancellation is cooperative: the partial result is returned
with `cancelled: true` instead of throwing.

- **TypeScript/JavaScript** uses parser facts.
- **Python** resolves `from .mod import x` relative imports, `__init__` and namespace packages, and
  records ambiguous, unresolved, or dynamic imports as unsupported instead of guessing.
- **Rust** strips comments, documentation, and string literals before matching, so a `use` inside a
  comment or string is never a dependency. `crate`/`self`/`super` paths, grouped and re-exported
  `use` items, and `mod` declarations resolve against scanned modules. `#[cfg]`, macros, and
  includes are reported as uncertain. `parseCargoManifest` reads the description and dependency
  names from `Cargo.toml` without running Cargo; `readRustProjectMetadata` optionally enriches that
  with `cargo metadata` using the caller's existing permissions, and degrades to the manifest with
  an explicit coverage note when the process is unavailable.

Manual relations such as a Tauri IPC contract are marked `declared` and stay separate from
`detected` relations in the architecture view, which renders a local SVG without a browser address.

## Checks

```bash
npm run check      # tsc --noEmit, eslint, and the production build
npm run test:host  # VS Code activation smoke test
```

Unit tests for the project layer run with `npx vitest run test/project*.test.ts test/editorTab*.test.ts test/turnReview*.test.ts`.

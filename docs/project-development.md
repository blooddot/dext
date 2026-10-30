# Project knowledge and editor tabs

The Project settings section lives in **Project > Overview** as one collapsible section. It includes initialization choices, the workspace Plan directory, project-relative API, Skill, and MCP directories, and the Standard, Deep, or Whole evidence depth. Resource directory fields show the active `.dext/api`, `.dext/skills`, and `.dext/mcp` directories and accept comma-separated workspace-relative paths. Expand **Advanced reading settings** for file and character limits and workspace-relative scope patterns. Changes save automatically to `.dext/project.json` and apply to new turns, Plan documents, resource reloads, initialization, and diagram generation. Before a project saves its own value, the old VS Code settings remain a compatibility fallback. Whole still has a 1,000-file limit, and blank evidence numeric fields follow the selected depth.

English | [简体中文](project-development.zh-CN.md)

[Back to README](../README.md)

**Project knowledge** is long-lived and belongs to the repository. Conversation history is stored separately; clearing a conversation does not delete project knowledge.

[Project files](#project-files) · [Knowledge dimensions](#knowledge-dimensions) ·
[Editor tabs](#editor-tabs) · [Explicit initialization](#explicit-initialization) ·
[Diagram rendering](#diagram-rendering) · [Checks](#checks)

## Native Project and Plan

Project owns long-term norms; Plan describes one change. Plan checks actual availability (`absent`, `ready`, `unavailable`) before assessing impact (`none`, `change`, `unknown`, `conflict`). Legacy intent, objects and architecture work through the same port before migration. There is no second Spec mode or derived normative graph.

Explicit **Build/Update project model** chooses existing model, legacy migration, durable documents, source code, or empty project. Existing models update through revision guards. Legacy migration backs up exact bytes in `.dext/project/migrations/`, keeps stable IDs with deterministic aliases for collisions, then commits `.dext/project/model.json`. After that commit, legacy norms are neither reread nor dual-written; a damaged native model reports an error. Saved diagrams remain available. Documents are adopted at their original paths; empty projects get a draft without requiring a source index or AI provider.

Native initialization uses a bounded package (100 files, 20,000 characters per file, 80,000 total), prioritizing guidance before other evidence. The workspace include scope still applies. Source-based generation builds goals, architecture and responsibilities; generated candidates are drafts. A checkpoint records route, source fingerprints, model revision and AI settings. Interrupted candidates resume only with an identical baseline. The legacy source-index pipeline described below remains available to its existing consumers and tests; it is no longer a prerequisite for native initialization.

The model stores stable typed nodes and explicit relationships. A body has exactly one owner: inline text or a workspace document with a content hash, including documents under `.dext/project/knowledge/`. Plan files cannot be normative nodes or document bodies. The Knowledge reader is read-only: an article renders its saved body, its sources and **Plan a change**. Confirming or rewriting a norm happens in the sidebar's Resources mode **Project**, which lists the inline norms of this workspace, drafts the body from its cited evidence and saves it to the same model; an unchanged body counts as an accepted/current confirmation, a changed body as edited/needs_verification. A document body is confirmed by editing its file. Accepted/edited bodies and relationships survive AI regeneration. Deleting an endpoint requires updating its incoming relationships in the same validated batch.

Native writes check revision and document hashes. Multi-document updates retain recovery journals and can resume the same request after interruption. Rollback requires backing up edits made after migration; restoring the old backup blindly would lose new norms. Reading a page, running Plan or querying never initializes or migrates Project.

Build binds the semantic plan body and relevant normative content; execution evidence lives in extension storage under a workspace-isolated `plan-project/` directory. Each Build captures a fresh baseline and the finished run deletes it, so no copy of the source tree accumulates. Final review uses content changes, not all changes against HEAD. Missing, non-text, concurrent or over-budget evidence stays unresolved. A `change` review writes the norms itself: the host authorizes only the norms this run read, requires every delta to cite a path the run changed, and refuses more than 20 updates or 40,000 characters, leaving the proposal pending instead. A model that omits provenance fields keeps the stored review, freshness, origin and evidence. Norms citing a changed source become `needs_verification`, and each receipt is recorded per operation. Completion retains the plan and the reconciliation record.

`project_query` reads only the persisted native model, with depth at most 8, at most 200 nodes and a bounded result body. Project settings can disable it. Pi receives the corresponding private current-turn host callback; arbitrary MCP and write tools remain disabled in read-only turns.

### Verification record (2026-10-28)

Automated checks: `npm run check`, `npm run check:ui`, and `npm run check:ui:conversations` passed. `npm run test:host` passed in the installed VS Code; its clipboard assertions were skipped because focus and the OS clipboard baseline were unavailable. Real Codex calls in a temporary project passed the expected `none` and `change` Plan cases, and classified an unplanned return-type change as a conflict rather than `none`. Run the opt-in suite with `DEXT_TEST_PROJECT_CODEX` set to the installed executable: `npx vitest run test/planProjectLive.test.ts`.

The full manual F5 sequence (Build and cancel/restart in the user's desktop session) remains a separate acceptance check; browser message tests and real-model tests are not evidence that a human completed it. No live check initializes or migrates this repository's Project data.

## Project files

Project data lives under `.dext/` in the workspace:

| Path | Contents |
| --- | --- |
| `.dext/project.json` | Schema version, optimistic `version`, project paths (`planDirectory`, `apiDirs`, `skillDirs`, and `mcpDirs`), evidence settings and AI CLI selection. |
| `.dext/project/model.json` | Authoritative native nodes, relationships and body ownership after explicit initialization or migration |
| `.dext/project-intent.json` | Legacy semantic knowledge, used only before native migration |
| `.dext/objects/<id>.json` | One accepted long-term object per file |
| `.dext/architecture.json` | Declared design decisions and architecture rules. Rules are evaluated against the saved diagram they name, never against a source scan. |
| `.dext/diagrams/<id>.json` | Canonical AI-generated diagram IR (renderer-neutral, one file per diagram) |

`ProjectStore` reads and writes these files through a small file host, so the same logic runs in the
extension, a worker, or an in-memory test double. Every write takes the expected `version`; a
concurrent change is reported as `{ status: "conflict" }` instead of overwriting. A missing or
corrupt `project.json` falls back to defaults so development is never blocked.

`ProjectObjectReference` stores a stable `objectId`. Renaming an object keeps its id and remembers
the previous names as aliases, so references, links, and tests survive the rename.

Explicit `evidence` settings control the reading budget and scope. Projects without them must save Evidence reading in Overview > Project settings before building or updating the index. The page guides users to the depth and scope controls and provides a Save reading settings button to confirm the displayed defaults. Explicit `include: []` is valid and uses the built-in file set. Legacy `scan.roots` no longer affects the scope. Legacy `scan` and unknown extension fields remain readable and are preserved, but are not generated. This repository already sets `evidence.include` to `["src/**"]`, so removing its redundant `scan` does not change the source scope. Whole increases the budget; it does not remove scope restrictions.

Review presets have been removed. New definitions and saved definitions without `preset` never generate it; an existing legacy `preset` is preserved as inactive data. Project paths and evidence budgets are configured in `.dext/project.json` through Project settings. The retired VS Code directory and evidence settings are no longer read; missing paths use built-in defaults, while missing `evidence` requires an explicit save before indexing. Knowledge state, AI selection, versions and write timestamps remain in the document.

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

## Editor tabs

Project, API, Global Resources, and History open as editor tabs and share one layer:

- `editorTabTypes` defines the tab kinds, view types, titles, pages, and stable key format.
- `editorTabState` validates persisted state; an unknown page falls back to the kind's default.
- `editorTabManager` creates at most one panel per key, supports reveal/close, and uses an injected
  host so it can be tested without VS Code.
- `editorTabSerializer` registers a `WebviewPanelSerializer`-compatible restore path with a claim
  guard, so a serializer restore and a proactive restore never double-open the same tab.

The Project tab exposes **Overview** and **Knowledge**; saved diagrams live in the reader's secondary directory. The old `architecture` page key opens that gallery inside the reader, and the retired `specs` key restores the reader, preserving restored tabs. Each module article folds in its own norm and relationships, so authored text and its maintenance controls never sit on two pages. Hooks and single-run metadata remain outside Project.

## Exploring topics

**Knowledge** uses a searchable directory and one selected article. Each topic puts its explanation, interactive or structural view, source references and related topics together. Structure topics describe boundaries and their declared dependencies; flow topics pair the saved step descriptions with their graph. The introduction also keeps a collapsed glossary, architecture rules and decisions.

Text and diagrams share the existing semantic IDs. Flow graphs use only explicit `nextStepIds`, never array order as a claimed transition. Selecting a diagram node or connection highlights the corresponding explanation and exposes its recorded sources; selecting a text step selects its node. Related-topic links continue the same reading path. Older intent files work without a migration; optional step descriptions improve future generations. Independent saved diagrams remain available, and views without a semantic link are labelled as such instead of matched by title.

**Check sources** explicitly compares referenced files, including linked diagrams, with their saved hashes. Changed/missing evidence marks the topic for review; unreadable files and absent hashes stay unknown. Checks are bounded to 1,000 files, 256 KiB per file and 32 MB total, are session-only and do not call AI or rewrite knowledge. Opening the reader does not check files. Unchanged files do not establish semantic correctness.

**Additional views > Generate a focused view** rereads current evidence, prioritizing the topic's files within the configured scope and budget. The saved topic is a historical hypothesis. Topic workflows are limited to 8 nodes; boundary views to 10. New views stay in the current topic and link to existing step/boundary IDs where the source supports them. Relationships must cite actual read excerpts, not just inventory entries.

**Overview > Build project model / Update project model** builds a local JS/TS, Rust and Python structure index, then organizes complete file-level facts into responsibility outlines in bounded AI batches. Each module stage records the content hashes of the files it read, so an update re-drafts only the modules whose files changed and reuses the saved prose and review state for the rest; a model saved before these hashes existed re-drafts every module once. A final overview can record evidence-backed C4 boundaries; detailed module flows remain on demand. One closing batch assigns every module to a few AI-named functional areas: that grouping is navigation only, never a merge or a change of ownership. A module named by its title instead of its id is accepted, and a batch that drops or duplicates a module is asked once more with the exact errors; if that also fails, the model stays ungrouped and the progress report says so. Selecting a Knowledge module reads saved data; **Analyze this module / Update module analysis** explicitly generates its explanation and Archify diagram together.

Node titles are short English labels that reuse the names the code and the UI already use (for example `Conversation history`); when the interface and the code name the same thing differently, **the code name wins the title** and the interface name is documented in the body instead, so a title always lands on a real symbol. Bodies stay in Simplified Chinese. Each body's first `## Responsibility` bullet records the mapping once, as `**Names**: <interface name> → <public symbol or entry file>` — or `<code name> → <files>` for a project without a user interface — so the interface label, the code symbol and this record all name the same responsibility.

The article uses the same diagram's `metadata.topicSummary` and node descriptions. `topicId`, `topicAnalysis=1` and `topicBasis` record ownership and the project-model basis. One `writeDiagram` saves prose, evidence and graph together; updates reuse the diagram ID. Refreshing the project model preserves saved analyses and marks changed module outlines for update. Failures and cancellations retain the previous result and do not modify other modules. Manual prose editing and automatic development-conversation injection are not implemented.

Local indexing has no candidate/file-count cutoff and honors the configured scope and exclusions. Tree-sitter WASM grammars ship with the extension. Content hashes reuse unchanged parse results in the extension workspace storage cache; deleted files disappear and configuration changes recompute dependency resolution. Per-file size limits still apply, and unreadable, malformed and unsupported files are reported. Package/directory groups remain physical index metadata. Complete file membership, signatures and static dependencies feed candidate neighborhoods based on file names and dependencies; neighborhoods are scheduling hints, not knowledge boundaries. AI can split a directory and merge a feature across directories. Source-scoped indexing also reads README and configuration files in source ancestors for package/project context, without expanding the source scope.

AI fact batches use at most 120,000 evidence characters (or the smaller configured limit), up to 12 candidate neighborhoods and 60 source files per request. Oversized neighborhoods split by file; no file or declaration is dropped to fit. A single file that exceeds the budget produces an explicit error. Every file must have exactly one primary responsibility owner; unknown/duplicate/missing ownership and foreign entry points fail validation. Later bounded passes reconcile responsibility summaries across batches, preserving every member. Non-reducing large passes retain separate outlines instead of forcing a fixed total count. The overview records supported C4 runtime boundaries from actual document/configuration and targeted source excerpts, not from import edges. Source candidates come from indexed runtime imports and entry declarations; reads stay within the evidence budget and preserve original line numbers and full-file hashes. Cross-batch consumers help distinguish shared infrastructure from a single feature. Runtime source excerpts retain boundary-priority order through final packaging, with a separate 1,400-character cap unaffected by the deep-read preset. The source budget balances deployment roots, packaged launchers, browser entries and alternative transports before duplicate launcher candidates; one file may contribute disjoint process, network and transport-dispatch excerpts, and citations in unread gaps are rejected. Every index, including a single source batch, consolidates outlines into reading topics using member paths, declaration summaries, per-file dependencies and cross-batch consumers. Consolidation may split provisional groups and reassign individual files, while validating exact file ownership and entry points; small supporting helpers should be absorbed into coherent features instead of becoming individual topics. Unresolved questions are stored separately from module purposes. Only questions ending in a question mark and naming an exact member path survive normalization; generic verification disclaimers are filtered. These checks enforce specificity of presentation, not the factual validity of a question. Shared formats and libraries alone do not justify a module boundary. The final overview must also assign every responsibility to exactly one functional area in capabilities, with missing, duplicate and unknown membership rejected. Knowledge groups modules under these areas; legacy flat indexes remain readable. Module reads prioritize persisted `sourceFiles` plus direct dependencies, excluding unrelated same-directory files. They remain capped at 32 files, 12,000 excerpt characters per file and 96,000 total evidence characters. Knowledge exposes the complete member list; directory-group and knowledge-module counts are displayed separately. New responsibility IDs derive from sorted member paths. Index updates preserve IDs for unambiguous continuations with at least 50% file-set overlap (intersection over union); splits and merges retain predecessor references. Changed topic bases mark existing analyses stale. Saved diagrams are never rewritten during indexing. Previous and already orphaned analyses with recorded member files remain accessible as historical views requiring review, not as verified explanations of the new boundary. Legacy contexts without file ownership remain readable; updating the index explicitly adopts the new directory, and existing diagrams remain saved.

Overview also reads ancestor esbuild/Vite/Webpack/Rollup configuration as deployment evidence, without executing build scripts or treating them as application modules. Type-only TypeScript imports remain classified in the index and are excluded from non-type consumer lists. A bounded, single AI review revisits small helpers whose sole non-type consumer belongs to another module, using exact ownership validation. Remaining ownership concerns, isolated C4 elements and internal containers without knowledge links are saved in `qualityIssues` and shown in Overview and the relevant Knowledge topics. These are review signals, not proof of incorrect ownership or a semantic correctness score. System-context views project container interactions to their parent systems, combine descriptions and evidence, and remove internal self-edges; container-level relationships remain unchanged.

Resolution covers common relative imports, local TS path mappings, Python package/src layouts and Rust module/use paths. Macro expansion, conditional compilation, dynamic loading, inherited TS configurations and cross-language runtime communication are not fully resolved; unresolved references remain explicit. The cache contains structural facts, not full source bodies.

**Derived structure graph.** Each index also derives an in-memory graph from the same file facts: resolved import edges carry `extracted`, `inferred` or `ambiguous` provenance, PageRank identifies hubs, strong components identify cycles, and a deterministic Louvain pass groups tightly coupled files. It is never persisted, never replaces AI ownership, and never upgrades an import into a runtime call. Bounded diagram evidence uses graph degree to spend its source slots on hubs and shared infrastructure, then attaches a compact edge set (at most 200 edges among the selected paths). A generated `depends_on` relation is annotated with `metadata.provenance` and `metadata.structureMatch`; a reverse import direction sets `metadata.structureConflicts` and a diagram-level warning instead of deleting the model's relation. Community disagreement is exposed only as the review signals `community-split`, `module-fragmentation` and `surprising-dependency` in `qualityIssues`. After a completed project model, Dext injects a host-owned `dext_structure` tool server into Codex, Claude and DeepSeek Harness conversations automatically; it exposes the read-only `structure_query` operations (node, consumer, dependency, community, hub, search and shortest path) without a user MCP manifest, a separate install command or a system `node`. The Project settings **Agent tools** section turns it off per project (on by default); a project without a saved model never injects it at all. The server is launched from Dext's own Electron/Node binary, reads the cached graph on each call and exits with the conversation. Type-only imports are excluded from communities, cross-module consumer counts and runtime-oriented traversal.

## Explicit initialization

The following source-index pipeline documents the legacy generation path. Native initialization uses the five routes described above and does not require this pipeline.

Opening, restoring, switching or refreshing the Project tab only reads saved `.dext` data. Dext never
enumerates source files, runs a parser, calls AI, or writes `.dext` in the background. Source text is
read only after the user chooses **Build project model**, **Update project model**, **Check evidence**, or generates a diagram.

The initialization service uses three phases:

1. **Preparing** — locally parse the configured source scope, cache complete file facts and derive candidate neighborhoods. Read bounded document/configuration excerpts for architecture evidence. Preserve exclusions, path validation, cancellation and secret redaction.
2. **Generating** — the selected Project AI CLI assigns files to responsibility outlines under strict JSON contracts, then reconciles outlines across batches with exact membership checks. A final request generates the overview and optional C4 model. No detailed module diagrams are generated at this stage. Evidence, stable-id references and kind-specific diagram semantics
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

While **Preparing** or **Generating**, **Pause** aborts the in-flight step without writing generated
artifacts and keeps the accepted output of every completed AI stage in
`.dext/project-initialization.checkpoint.json`. **Resume initialization** reloads that checkpoint and
continues after the last completed stage, so completed responsibility batches and reconciliation
rounds are not sent to the model again. The checkpoint stores each responsibility batch together with
the signature of its exact model input. Before resuming, Dext re-indexes the current sources and
compares the fingerprint (structure hash, index version, evidence input hash, prompt/schema version
and selected Project AI model/reasoning/speed):

- an exact match continues after the last completed stage;
- when only the sources or their trimmed evidence changed, every completed batch whose candidate
  files, documentation context and evidence contract are still identical is adopted without another
  model call. Only affected batches and the global reconciliation/review/overview stages rerun.
  Repository-wide counters (`Local index: … reused`, `omitted`) are not part of a batch's identity,
  so a warm parse cache does not invalidate batches; adding or deleting a file can still re-pack the
  batch list, and the shifted batches are regenerated. The output reports how many batches were
  reused. A change large enough to re-group every batch leaves nothing to reuse and regenerates all
  of them; the global stages always rerun, so the architecture (capabilities and C4 boundaries) is
  rebuilt from the current sources even when some batches are inherited;
- a changed prompt/schema/index version or Project AI settings discards the checkpoint and
  regenerates from the current sources.

A rejected checkpoint reports the fields that changed (for example `project sources` or `Project AI
settings`). The checkpoint is removed after the model is saved successfully. **Saving** does not
offer Pause because it may already have written files. The running panel shows an overall percentage
plus elapsed time; a resumed run re-indexes first while the bar keeps the checkpoint's percentage, so
re-indexing does not look like a fresh start, and then continues the AI portion from that point. The
paused card replaces the running card as soon as the run reports cancellation, and **Resume
initialization** renders the running card immediately — the data source reads the checkpoint before
it starts the state machine, so the page never waits for the first stage before reacting. The
aborted call may still be settling at that point; resuming from the paused card in that window is
allowed, and the older run cannot repaint over the newer one.

A project with no valid saved intent shows **Not initialized** and an explicit initialization entry.
A legacy `initialized` flag, old scan data or an engine-preference file alone never counts as success.
Running, failed, cancelled, and initialized-but-missing-diagram states are shown separately. On restart,
state is recovered from the saved intent, saved diagrams and the initialization record: a project with
only diagrams keeps them viewable and reports that the knowledge model still needs initialization. A
checkpoint left by a run that stopped before the window closed is shown as resumable after the reload:
without a saved model the card offers **Resume initialization**, and with one Overview keeps the
completed card but states that **Update project model** resumes the checkpoint.

## Diagram rendering

Project Intent and the renderer-neutral `ProjectDiagram` IR remain the data sources. Structural, C4, workflow, sequence, data-flow, lifecycle, tree and class views all use bundled Archify 3.2.0 as their only renderer. Bundled Mermaid 11.17.2 is still used for `mermaid` fenced code blocks in conversation and form Markdown; it is not a Project diagram renderer. Project IDs, prose and source navigation come from the saved model, without an online rendering service.

Seven kinds share the common node/relation/evidence structures and add optional, renderer-neutral
semantics:

| Kind | Optional semantic structures |
| --- | --- |
| Architecture | Boundaries that group existing nodes; dependency direction on relations |
| Workflow | Lanes and `laneId` on nodes, explicit relation order, branch conditions, exception paths, phases/groups for grouped layout |
| Sequence | Ordered participants and call/return messages covering every relation |
| Data flow | Two to five stages with `stageId` on every node |
| Lifecycle | Explicit initial/normal/terminal states, events, conditions and transitions |
| Tree | A single root and `parentId` parent chains; no cross-branch relations |
| Class | Explicit `classKind` and members on nodes; `inheritance`/`realization` relations |

Archify renders in an isolated sandbox and retains native animation, zoom and SVG export. Node selection and native route journeys link to prose. Reader playback follows a recorded main path or message order; branching workflows without a main path do not invent execution order. If the runtime cannot render, the reader shows an explicit error naming the reason and keeps the explanation, evidence and saved model available; it never switches to a second layout engine. Lifecycle diagrams use Archify schema v3, whose ordered `mainPath`, semantic states and transitions let the renderer derive all geometry. No stored diagram migration is required.

**Structure map and Type map** are derived on the fly from the current structure index; they are never written to `.dext/diagrams` and never sent to AI. The Structure map projects project → directory module → representative file → representative declaration. The Type map projects explicit types, their declared members, and only unambiguous `extends`/`implements` (Python bases) edges. Index version 4 records stable symbol ids, `ownerId`/`ownerName`, member kinds, type/parameter/return text, visibility and modifiers, plus explicit heritage; TS/JS extracts classes, interfaces, enums and their members, Python extracts classes/methods/class-level annotated fields, and Rust extracts structs/enums/traits, fields and impl methods. Rust `impl Trait for Type` edges and Python instance fields are intentionally not inferred. Named heritage targets must be unique among the selected types or the edge is skipped with a theme warning. A cache written by an older index version is rejected, so upgrade Dext and run **Build project model** or **Update project model** once to populate the local index and both maps.

Optional `intent.c4` records systems, people, external systems and runtime containers. `systemId` identifies the focal system; containers use `parentId` for system ownership and `contextIds` for responsibility links. Every element and relationship requires evidence from a read source/document excerpt. The reader derives separate Project landscape (C1) and Runtime units (C2) views, then links to responsibilities and flows. Directories are never inferred as containers. Existing models remain usable without C4; the structure index generates C4 only when read source/configuration/documentation supports runtime boundaries. ER diagrams are still outside this scope; the new class kind is limited to the explicit type facts above.

The reader supports zoom, fit, expand, SVG export and a collapsed **Diagram model** panel. A failed render leaves the explanation, evidence and saved model available, and opens that panel so the cause and model remain inspectable. Queued results cannot replace a newer topic. SVG export and source navigation resolve the displayed diagram's ID and saved timestamp in the host. All relations are also listed as keyboard-accessible **Connections** entries.

The Knowledge page has no reading rail beside the article: the article uses the width the directory leaves. On a wide editor the diagram is docked beside the explanation and stays in view while the text scrolls, and the pane's share of the width grows with the window while the prose keeps its measure. An editor without room for that column keeps the diagram in the article between the explanation and its steps, so the renderer, its controls and its state are never duplicated.

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

`deny` flags a relation that exists, `allow` flags relations from `from` to disallowed targets, and `no_cycles` flags dependency cycles. The existing host evaluation uses stable Project IDs; the reader's **Project introduction > Architecture rules and decisions** shows its rules, violations and unavailable-evaluation notes. Rules are never guessed against a different diagram.


## Checks

```bash
npm run check      # tsc --noEmit, eslint, and the production build
npm run test:host  # VS Code activation smoke test (see README for environment requirements)
```

Browser checks run in a local Chromium or Edge, and are kept out of `npm run check` so the standard
gate does not depend on one being installed:

```bash
npm run check:ui                        # UI regression suite
node scripts/checkComposerLayoutUi.mjs  # composer attachment growth, footer alignment, narrow viewports
node scripts/checkStreamJumpUi.mjs      # jump-to-latest control never covers the conversation scrollbar
node scripts/checkEditorTabsUi.mjs      # shared editor shell, Project pages, CSP and themes
node scripts/checkProjectReaderUi.mjs   # hybrid rendering, C4, playback, source links, CSP and themes
node scripts/checkProjectDiagramsUi.mjs # retained Archify adapter and bridge compatibility
```

Unit tests for the project layer run with `npx vitest run test/project*.test.ts test/editorTab*.test.ts`.
`scripts/assertWebviewAssets.mjs` additionally proves from the esbuild dependency manifest that the
runtime bundle contains neither the TypeScript compiler nor the removed scan/engine implementations,
that the Archify entry point, CLI helper, seven schemas and seven renderers the adapter names are present,
including the tree/class renderers, the class grid helper, the locale manifest, render-output checker,
explainer checker and owned-temp/update helpers they import, and that
`vendor/project-diagrams/drawio` is not packaged. The rest of the vendored runtime is distributed
because `.vscodeignore` does not exclude `vendor/**`.

## First module migration / 第一轮模块迁移

Use `app` for composition, `platform` for shared infrastructure, and `features` for product responsibilities. `features` expresses this project's grouping; no industry popularity ranking is claimed. Do not introduce a parallel `modules` root or empty directory templates. Host code owns Node/VS Code; browser code owns DOM interaction; contracts and presentation remain environment independent.

Keep extension commands, message discriminants, CSP/nonce, `dist/extension.js`, `dist/webview/main.js`, `dist/webview/project.js`, `dext.agentProfiles`, `dext.agentSelection`, editor tab identity and all persisted Project schemas compatible. The composition root owns service disposal; providers unsubscribe on close and cancel their own requests. Preserve existing .dext data; acceptance uses temporary copies.

Compatibility entries have explicit exports and no implementation. Unmigrated consumers remain on those entries until their own migration; remove each entry only after its last external consumer moves. New feature code uses new paths.

| Previous path | Implementation |
| --- | --- |
| `src/core/projectIntent.ts` | `src/features/project/contracts/projectIntent.ts` |
| `src/core/projectKnowledge.ts` | `src/features/project/contracts/projectKnowledge.ts` |
| `src/core/projectDiagram.ts` | `src/features/project/contracts/projectDiagram.ts` |
| `src/core/projectDiagramAdapter.ts` | `src/features/project/contracts/projectDiagramAdapter.ts` |
| `src/core/projectEvidenceSettings.ts` | `src/features/project/contracts/projectEvidenceSettings.ts` |
| `src/core/projectSettings.ts` | `src/features/project/contracts/projectSettings.ts` |
| `src/webview/projectArchitectureTypes.ts` | `src/features/project/contracts/projectArchitectureTypes.ts` |
| `src/core/projectContext.ts` | `src/features/project/knowledge/projectContext.ts` |
| `src/core/projectReference.ts` | `src/features/project/knowledge/projectReference.ts` |
| `src/core/projectTopics.ts` | `src/features/project/knowledge/projectTopics.ts` |
| `src/core/projectIndexEvolution.ts` | `src/features/project/knowledge/projectModelEvolution.ts` |
| `src/core/projectArchitecture.ts` | `src/features/project/knowledge/projectArchitecture.ts` |
| `src/core/projectDiagramHistory.ts` | `src/features/project/knowledge/projectDiagramHistory.ts` |
| `src/core/projectC4.ts` | `src/features/project/presentation/projectC4.ts` |
| `src/core/projectDiagramPresentation.ts` | `src/features/project/presentation/projectDiagramPresentation.ts` |
| `src/core/projectStructure.ts` | `src/features/project/host/indexing/projectStructure.ts` |
| `src/core/projectStructureKnowledge.ts` | `src/features/project/host/indexing/projectStructureKnowledge.ts` |
| `src/projectStructureHost.ts` | `src/features/project/host/indexing/projectStructureHost.ts` |
| `src/core/projectAiGeneration.ts` | `src/features/project/host/generation/projectAiGeneration.ts` |
| `src/core/projectIndexQuality.ts` | `src/features/project/host/generation/projectModelQuality.ts` |
| `src/projectService.ts` | `src/features/project/host/projectService.ts` |
| `src/projectStore.ts` | `src/features/project/host/persistence/projectStore.ts` |
| `src/vscodeProjectHost.ts` | `src/features/project/host/projectPanelDataSource.ts` |
| `src/projectEditorProvider.ts` | `src/features/project/host/projectEditorProvider.ts` |
| `src/projectDiagramViewer.ts` | `src/features/project/host/diagrams/projectDiagramViewer.ts` |
| `src/core/projectDiagramRegistry.ts` | `src/features/project/host/diagrams/projectDiagramRegistry.ts` |
| `src/core/projectDiagramProcess.ts` | `src/features/project/host/diagrams/projectDiagramProcess.ts` |
| `src/core/archifyAdapter.ts` | `src/features/project/host/diagrams/archifyAdapter.ts` |
| `src/webview/projectPanel.ts` | `src/features/project/presentation/projectPanel.ts` |
| `src/webview/projectSettingsView.ts` | `src/features/project/presentation/projectSettingsView.ts` |
| `src/webview/projectTopicsView.ts` | `src/features/project/presentation/projectTopicsView.ts` |
| `src/webview/projectArchitectureNotes.ts` | `src/features/project/presentation/projectArchitectureNotes.ts` |
| `src/webview/projectReader.ts` | `src/features/project/browser/projectReader.ts` |
| `src/webview/projectReaderArchify.ts` | `src/features/project/browser/projectReaderArchify.ts` |
| `src/webview/archifyBridge.ts` | `src/features/project/browser/archifyBridge.ts` |
| `src/editorTabTypes.ts` | `src/platform/editor-tabs/editorTabTypes.ts` |
| `src/editorTabState.ts` | `src/platform/editor-tabs/editorTabState.ts` |
| `src/editorTabSerializer.ts` | `src/platform/editor-tabs/editorTabSerializer.ts` |
| `src/editorTabManager.ts` | `src/platform/editor-tabs/editorTabManager.ts` |
| `src/editorTabHtml.ts` | `src/platform/editor-tabs/editorTabHtml.ts` |
| `src/resourceSession.ts` | `src/features/resources/contracts/resourceSession.ts` |
| `src/resourceIcons.ts` | `src/features/resources/presentation/resourceIcons.ts` |
| `src/resourceBrowserProvider.ts` | `src/features/resources/host/resourceBrowserProvider.ts` |
| `src/apiEditorProvider.ts` | `src/features/resources/host/apiEditorProvider.ts` |
| `src/globalResourcesEditorProvider.ts` | `src/features/resources/host/globalResourcesEditorProvider.ts` |
| `src/webview/apiPanel.ts` | `src/features/resources/presentation/apiPanel.ts` |
| `src/webview/globalResourcesPanel.ts` | `src/features/resources/presentation/globalResourcesPanel.ts` |
| `src/agentProfiles.ts` | `src/features/agents/host/agentProfiles.ts` |
| `src/agentSelectionDefaults.ts` | `src/features/agents/presentation/agentSelectionDefaults.ts` |
| `src/core/toml.ts` | `src/features/agents/host/toml.ts` |
| `src/core/fileSearch.ts` | `src/features/workspace/domain/fileSearch.ts` |
| `src/webview/outputLink.ts` | `src/features/workspace/browser/outputLink.ts` |
| `src/webview/fileSearchClient.ts` | `src/features/workspace/browser/fileSearchClient.ts` |

Additional verification file: `test/sidebarLayout.test.ts` — source-location assertions follow extracted implementations; layout and behavior expectations remain enforced. / 额外验证文件：源码断言改为读取迁移后的实现，保留布局和行为约束。

Additional verification file: `scripts/checkProjectDiagramsUi.mjs` — use the new browser startup entry, retaining the same rendered diagram assertions. / 图表浏览器检查改用新启动入口，保留原渲染断言。

### Behavior, boundaries and next-round entry criteria

Behavior contracts: Project starts at `features/project/browser/entry.ts`, reads `window.__dextApi`, and still builds to `dist/webview/project.js`. Existing page, diagram, progress and result message discriminants remain unchanged; `projectPage` accepts an optional topic ID. File search still uses `searchFiles { requestId, query }` and `searchFilesResult { requestId, files }`, a 20,000-file index, 15-second cache and 40 suggestions with existing exclusions. Request identity and disposal checks suppress stale responses.

Editor restore version remains 1; keys retain `dext.editor:<kind>[@scope][#resource]`. View types remain `dext.project`, `dext.api`, `dext.globalResources` and `dext.history`. `app/projectSetup.ts` registers Project editors, serializers and the diagram registry with the extension's disposal owner. Closing a page cancels its tasks and releases its subscriptions. The AI bridge receives narrow execution methods and Profile/Selection callbacks. Agent storage keys and Project paths/schema versions are unchanged; initialization succeeds only after saving, and failures/cancellation preserve the last valid result.

`checkModuleBoundaries.mjs`, included in `npm run check`, distinguishes type-only imports from runtime edges, checks transient environment dependencies, runtime cycles, feature-to-app dependencies, the `src/` root whitelist, `shared` purity, platform/feature environment direction, the `contracts/` directory rule and every removed path. Bundle metadata also rejects host code and Node/VS Code dependencies in browser output. Cross-feature collaboration through explicit contracts remains allowed.

`migrationExceptions` is empty. The remaining pure-layer type references to implementation modules are the seven exact entries in `declaredTypeEdges`; the remaining cross-feature host couplings are the four exact entries in `crossFeatureHostCouplings`. Adding or removing an entry without updating the list fails the check, and none of them bypasses environment or cycle checks.

Quality review treats sole runtime consumers as clues. Each reviewed concern returns `retained`, `reassigned` or `unresolved`, a reason and supplied evidence paths. Missing/duplicate decisions, foreign evidence and invalid ownership fail validation. Overview and Knowledge separate architecture defects, unresolved ownership and collapsed explained decisions; old data without review status remains unresolved. Static build-entry discovery supplies bounded startup/send/receive/host/transport windows, including injected APIs; it never executes build scripts. Dynamic entries and budget omissions are recorded. Isolated C4 elements permit one bounded relationship-only review grounded in read excerpts; failure, timeout or insufficient evidence preserves warnings, while cancellation propagates.

History remains readable after source movement, split or merge. Matching names alone cannot preserve identity; uncertain or orphan analyses show stale-boundary notices. Fixture, browser, extension-host and actual-AI checks remain separate. Use `node scripts/checkProjectReaderUi.mjs --saved-project --workspace <temporary-copy>` to browse generated data without writing to the real workspace.

A new round starts only after the complete checks pass and the compatibility/exception inventories are current. The conversation state/history, execution/plan review and browser components were split in round two; round three then dissolved `src/core/` and fixed the environment boundaries. The remaining behaviour work is listed under “Round three” below. Workflow kernels and Agent providers follow explicit execution/transport contracts; MCP and completion follow with separate connection, credential, cancellation and latency checks. Do not create empty feature modules or transfer remaining responsibilities into another large controller.

### Round three: shared kernel and environment boundaries

The third round dissolved `src/core/`. Shared contracts and pure tools moved to `src/shared/` (`contracts/`, `protocol/`, `lib/`), VS Code adapters to `src/platform/vscode/`, the composition roots to `src/app/`, and the remaining browser modules to their feature's `browser/` layer. `src/` now contains only `extension.ts`; `src/core`, `src/common`, `src/base`, `src/modules` and `src/utils` are forbidden by the boundary check.

The conversation browser split is complete: tab identity/cache, composer drafts, tab strip, output scroll, turn transcript, live Process/trace, Plan toolbar and patch review all live under `src/features/conversations/browser/`; `src/webview/main.ts` wires them to the protocol and the out-of-scope UI. The conversation modules under `src/features/conversations/` are assembled once by `src/app/conversationSetup.ts`.

### Acceptance records

Acceptance on 2026-10-20: `npm run check` passed (154 test files / 1504 tests passed; existing 3 files / 13 tests skipped), including boundaries, lint, types, build, declarations and five packaged WASM grammars. Default test concurrency is unchanged. `npm run check:ui`, editor-tab checks, saved-project reader checks and `npm run test:host` passed, covering themes, narrow layouts, fullscreen, playback, export, navigation messages, activation and Project/API/resource tab lifecycles.

A temporary post-migration source copy was analyzed through the real Codex Provider: all 229 source files received unique owners, with 3 additional documentation/configuration files; the output contained 50 responsibility modules and 2 architecture topics. Workspace search contracts and Agent selection presentation were retained with evidence-based explanations; no unresolved ownership or isolated C4 issues remained. Reader interactions cite actual browser send/receive and host-handler excerpts; MCP retains HTTP/stdio and Archify is an internal subprocess. A subsequent real module analysis produced 10 nodes and 8 relationships. Its first output failed validation, automatic repair passed, and the saved diagram rendered natively in Archify under the browser/fullscreen checks. Evidence is in `.tmp-tb/final-live.log`, `.tmp-tb/final-ai-reader.log` and `.tmp-tb/project-reader-ui/generated-module-analysis.png`.

This records one real run, not a fixed module count or a guarantee of semantic completeness. Unread/truncated module evidence remains explicit, and sequential AI-call latency was not optimized. The plan file and the real workspace's evidence, intent and project settings retained their original hashes; generated acceptance data was written only to temporary copies.

### Historical compatibility inventory (all entries removed)

The tables below record the first- and second-round inventories. Every path in them has
been deleted; they are kept only to explain the migration and are **not** current import
instructions. Current imports use the target paths listed in the first migration table and
in `docs/conversation-development.md`.

| Compatibility entry | Remaining consumers |
| --- | --- |
| `src/resourceDocuments.ts` | `test/apiReference.test.ts`, `test/apiSource.test.ts` |
| `src/core/projectIntent.ts` | `test/projectIntegration.test.ts`, `test/projectIndex.test.ts`, `test/projectContext.test.ts` |
| `src/core/projectKnowledge.ts` | `test/projectStore.test.ts`, `test/projectKnowledge.test.ts`, `test/projectIntegration.test.ts`, `test/projectContext.test.ts` |
| `src/core/projectDiagram.ts` | `test/archifyLayoutBudget.test.ts`, `test/archifyAdapter.test.ts`, `test/projectStore.test.ts`, `test/projectIntegration.test.ts`, `test/projectIndex.test.ts`, `test/projectDiagramRegistry.test.ts`, `test/projectDiagramPresentation.test.ts`, `test/projectDiagramAdapter.test.ts`, `test/projectDiagram.test.ts`, `test/projectArchitecture.test.ts` |
| `src/core/projectDiagramAdapter.ts` | `test/archifyAdapter.test.ts`, `test/projectIntegration.test.ts`, `test/projectDiagramRegistry.test.ts`, `test/projectDiagramAdapter.test.ts`, `test/projectDiagram.test.ts` |
| `src/core/projectEvidenceSettings.ts` | `test/projectEvidenceSettings.test.ts` |
| `src/core/projectSettings.ts` | `test/projectWorkspaceSettings.test.ts` |
| `src/core/projectContext.ts` | `test/projectContext.test.ts` |
| `src/core/projectReference.ts` | `src/webview/projectReferenceClient.ts`, `test/projectReference.test.ts`, `src/core/fileReference.ts` |
| `src/core/projectTopics.ts` | `test/projectIndex.test.ts` |
| `src/core/projectArchitecture.ts` | `test/projectArchitecture.test.ts` |
| `src/core/projectDiagramHistory.ts` | `test/projectDiagram.test.ts` |
| `src/core/projectDiagramPresentation.ts` | `test/projectDiagramPresentation.test.ts` |
| `src/core/projectAiGeneration.ts` | `test/archifyAdapter.test.ts`, `test/projectIntegration.test.ts`, `test/projectInitializationOutput.test.ts`, `test/projectIndex.test.ts` |
| `src/projectService.ts` | `test/projectIntegration.test.ts` |
| `src/projectStore.ts` | `test/projectStore.test.ts`, `test/projectIntegration.test.ts`, `test/projectInitializationOutput.test.ts`, `test/projectEvidenceSettings.test.ts` |
| `src/vscodeProjectHost.ts` | `test/projectTopicsHost.test.ts`, `test/projectInitializationOutput.test.ts`, `test/projectEvidenceSettings.test.ts`, `test/projectEvidenceSelection.test.ts` |
| `src/projectDiagramViewer.ts` | `test/projectDiagramViewer.test.ts` |
| `src/core/projectDiagramRegistry.ts` | `test/projectIntegration.test.ts`, `test/projectDiagramRegistry.test.ts` |
| `src/core/archifyAdapter.ts` | `scripts/checkProjectDiagramsUi.mjs`, `test/archifyLayoutBudget.test.ts`, `test/archifyAdapter.test.ts` |
| `src/webview/projectPanel.ts` | `scripts/checkProjectDiagramsUi.mjs` |
| `src/webview/archifyBridge.ts` | `scripts/checkProjectDiagramsUi.mjs` |
| `src/editorTabTypes.ts` | `test/editorTabState.test.ts` |
| `src/editorTabState.ts` | `test/editorTabState.test.ts` |
| `src/editorTabSerializer.ts` | `test/apiReference.test.ts` |
| `src/editorTabManager.ts` | `test/apiReference.test.ts`, `test/projectEvidenceSelection.test.ts`, `test/projectAiGeneration.test.ts` |
| `src/editorTabHtml.ts` | `scripts/checkProjectDiagramsUi.mjs` |
| `src/resourceSession.ts` | `src/features/conversations/host/historyStore.ts`, `test/resourceConversation.test.ts` |
| `src/apiEditorProvider.ts` | `test/apiReference.test.ts` |
| `src/webview/apiPanel.ts` | `test/apiSource.test.ts` |
| `src/webview/globalResourcesPanel.ts` | `test/apiSource.test.ts` |
| `src/agentProfiles.ts` | `test/agentRunner.test.ts`, `test/builtinCli.test.ts`, `test/harnessPresetSelection.test.ts`, `test/harnessPresets.integration.test.ts`, `src/core/agentRunner.ts`, `src/conversationPreferences.ts`, `src/core/builtinCli.ts`, `src/core/harnessPresets.ts`, `src/core/types.ts`, `src/core/deepseekHarnessRunner.ts`, `src/core/deepseekHarnessPolicy.ts`, `src/core/runtime.ts` |
| `src/core/toml.ts` | `test/toml.test.ts` |
| `src/webview/outputLink.ts` | `test/openImageReference.test.ts` |
| `src/webview/fileSearchClient.ts` | `src/webview/codeEditor.ts` |

Derived diagram builders live in `src/features/project/host/diagrams/projectStructureMap.ts` (Structure map)
and `src/features/project/host/diagrams/projectClassMap.ts` (Type map); their coverage is
`test/projectStructureTree.test.ts` and `test/projectStructureClass.test.ts`, with extraction covered by
`test/projectStructureTypes.test.ts` and cache compatibility by `test/projectStructureCache.test.ts`.

Removed unused entries / 已移除无消费者入口：`src/webview/projectArchitectureTypes.ts`, `src/core/projectIndexEvolution.ts`, `src/core/projectC4.ts`, `src/core/projectStructure.ts`, `src/core/projectStructureKnowledge.ts`, `src/projectStructureHost.ts`, `src/core/projectIndexQuality.ts`, `src/projectEditorProvider.ts`, `src/core/projectDiagramProcess.ts`, `src/webview/projectSettingsView.ts`, `src/webview/projectTopicsView.ts`, `src/webview/projectArchitectureNotes.ts`, `src/webview/projectReader.ts`, `src/webview/projectReaderArchify.ts`, `src/resourceIcons.ts`, `src/resourceBrowserProvider.ts`, `src/globalResourcesEditorProvider.ts`, `src/agentSelectionDefaults.ts`, `src/core/fileSearch.ts`。

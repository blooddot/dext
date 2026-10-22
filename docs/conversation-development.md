# Conversation development

This document describes how Dext conversations are put together: which module owns
which state, what each module may depend on, and where the migration moved code from.
It is the current operating guide; historical notes are separated at the bottom.

## Baseline

- Third refactor starts from `3d81b48` (`feat(conversations): collapse Process by default for new turns`).
- The second wave moved conversation state, execution, plan and patch review into
  `features/conversations/` and deleted the first wave's 36 forwarding modules.
- The third wave dissolved `src/core/` into `features/{agents,workflow,mcp,workspace}`,
  `shared/` and `platform/`, moved the VS Code adapters to `platform/vscode/`, the
  composition roots to `src/app/`, and the remaining conversation DOM to
  `features/conversations/browser/`. `src/` now contains only `extension.ts`.

## Removed entries and their targets (historical)

Every path below was deleted together with the import update in the same batch. The table
is a migration record only; it is **not** a current import instruction. No alias, mock,
build plugin or barrel file restores them: `scripts/checkModuleBoundaries.mjs` fails on a
static import, a type-only import, a literal dynamic load, a mocked specifier, an inlined
build entry string, a comment, or a restored file.

| Removed path | Target |
| --- | --- |
| `src/agentProfiles.ts` | contracts in `src/features/agents/contracts/agent.ts`, store/helpers in `src/features/agents/host/agentProfiles.ts` |
| `src/apiEditorProvider.ts` | `src/features/resources/host/apiEditorProvider.ts` |
| `src/core/archifyAdapter.ts` | `src/features/project/host/diagrams/archifyAdapter.ts` |
| `src/core/projectAiGeneration.ts` | `src/features/project/host/generation/projectAiGeneration.ts` |
| `src/core/projectArchitecture.ts` | `src/features/project/knowledge/projectArchitecture.ts` |
| `src/core/projectContext.ts` | `src/features/project/knowledge/projectContext.ts` |
| `src/core/projectDiagram.ts` | `src/features/project/contracts/projectDiagram.ts` |
| `src/core/projectDiagramAdapter.ts` | `src/features/project/contracts/projectDiagramAdapter.ts` |
| `src/core/projectDiagramHistory.ts` | `src/features/project/knowledge/projectDiagramHistory.ts` |
| `src/core/projectDiagramPresentation.ts` | `src/features/project/presentation/projectDiagramPresentation.ts` |
| `src/core/projectDiagramRegistry.ts` | `src/features/project/host/diagrams/projectDiagramRegistry.ts` |
| `src/core/projectEvidenceSettings.ts` | `src/features/project/contracts/projectEvidenceSettings.ts` |
| `src/core/projectIntent.ts` | `src/features/project/contracts/projectIntent.ts` |
| `src/core/projectKnowledge.ts` | `src/features/project/contracts/projectKnowledge.ts` |
| `src/core/projectMermaid.ts` | `src/features/project/presentation/projectMermaid.ts` |
| `src/core/projectReference.ts` | `src/features/project/knowledge/projectReference.ts` |
| `src/core/projectSettings.ts` | `src/features/project/contracts/projectSettings.ts` |
| `src/core/projectTopics.ts` | `src/features/project/knowledge/projectTopics.ts` |
| `src/core/toml.ts` | `src/features/agents/host/toml.ts` |
| `src/editorTabHtml.ts` | `src/platform/editor-tabs/editorTabHtml.ts` |
| `src/editorTabManager.ts` | `src/platform/editor-tabs/editorTabManager.ts` |
| `src/editorTabSerializer.ts` | `src/platform/editor-tabs/editorTabSerializer.ts` |
| `src/editorTabState.ts` | `src/platform/editor-tabs/editorTabState.ts` |
| `src/editorTabTypes.ts` | `src/platform/editor-tabs/editorTabTypes.ts` |
| `src/projectDiagramViewer.ts` | viewer guard in `src/features/project/host/diagrams/projectDiagramViewer.ts`, bridge in `src/features/project/browser/archifyBridge.ts` |
| `src/projectService.ts` | `src/features/project/host/projectService.ts` and the lifecycle contracts in `src/features/project/contracts/lifecycle.ts` |
| `src/projectStore.ts` | `src/features/project/host/persistence/projectStore.ts` |
| `src/resourceDocuments.ts` | contract in `src/features/resources/contracts/resourceDocuments.ts`, host in `.../resources/host/resourceEditorProvider.ts`, markup in `.../resources/presentation/resourceDocuments.ts` |
| `src/resourceSession.ts` | `src/features/resources/contracts/resourceSession.ts` |
| `src/vscodeProjectHost.ts` | `src/features/project/host/projectPanelDataSource.ts`, file host in `src/features/project/host/persistence/vscodeProjectFileHost.ts`, contracts in `src/features/project/contracts/` |
| `src/webview/apiPanel.ts` | `src/features/resources/presentation/apiPanel.ts` |
| `src/webview/archifyBridge.ts` | `src/features/project/browser/archifyBridge.ts` |
| `src/webview/fileSearchClient.ts` | `src/features/workspace/browser/fileSearchClient.ts` |
| `src/webview/globalResourcesPanel.ts` | `src/features/resources/presentation/globalResourcesPanel.ts` |
| `src/webview/outputLink.ts` | `src/features/workspace/browser/outputLink.ts` |
| `src/webview/projectPanel.ts` | `src/features/project/presentation/projectPanel.ts` |

Consumers were updated in the same commit as each deletion. The important split is by
symbol, not by filename:

- Agent types and constants come from `features/agents/contracts/agent.ts`; only
  `AgentProfileStore`, `codexConfiguredDefaults` and `modelOptionsFromCodexCache` come
  from the host module. Consumers: `app/application.ts`,
  `features/agents/host/*`, `features/workflow/domain|host/*`,
  `shared/contracts/types.ts`, `platform/webviewProtocol.ts`, `webview/main.ts`,
  `app/sidebarProvider.ts`, `conversationPreferences.ts` and the matching tests.
- Resources are split three ways: contracts (`resourceDocuments.ts`,
  `resourceSession.ts`), host (`resourceEditorProvider.ts`, `apiEditorProvider.ts`,
  `globalResourcesEditorProvider.ts`, `resourceBrowserProvider.ts`) and presentation
  (`resourceDocuments.ts`, `apiPanel.ts`, `globalResourcesPanel.ts`). Consumers are
  `extension.ts`, `app/application.ts`, `webview/main.ts`, `historyStore.ts`,
  `platform/webviewProtocol.ts`, `app/sidebarProvider.ts` and the resource tests.
- Project diagrams keep the contract (`contracts/projectDiagram.ts`), the knowledge
  helpers, the host registry/adapters and the browser bridge apart; the removed viewer
  entry mixed all four, so its consumers now import each symbol from its own module.
- Editor tab code is `src/platform/editor-tabs/*`; the tab pages consume the state and
  type modules directly.
- Workspace search uses `features/workspace/browser/fileSearchClient.ts` (browser) and
  `features/workspace/host/fileSearchController.ts` (host). `scripts/monaco-ref-lab/main.ts`
  keeps its extensionless type-only import of the browser module and resolves it.

## Verification of the cleanup batch

Run after any change to imports or removed entries:

```powershell
node scripts/checkModuleBoundaries.mjs
npm run lint
npm run typecheck
npx vitest run test/moduleBoundaries.test.ts test/agentProfiles.test.ts test/agentSelectionDefaults.test.ts test/agentRunner.test.ts test/builtinCli.test.ts test/harnessPresetSelection.test.ts test/harnessPresets.integration.test.ts test/toml.test.ts
npx vitest run test/apiReference.test.ts test/apiSource.test.ts test/editorTabState.test.ts test/projectIntegration.test.ts test/projectDiagramViewer.test.ts test/projectEvidenceSelection.test.ts
```

The boundary check reads `src`, `test` and `scripts`, so a reference hidden in a script
build entry or in a test mock fails the same way a normal import does.

## State ownership

Every mutable conversation fact has exactly one owner. Entries that still live in
`sidebarProvider.ts` are the ones this round has not moved yet; they are listed so the
mapping stays honest.

| State | Owner | Storage / lifetime |
| --- | --- | --- |
| Stored turns, plan context, provider session ids | `features/conversations/host/historyStore.ts` | `dext.history` workspace memento, serial writes |
| Pins, favorites, titles, layout, per-conversation selection, sort order | `features/conversations/host/conversationPreferences.ts` | `dext.pinnedConversations`, `dext.favoriteConversations`, `dext.conversationTitles`, `dext.conversationLayout`, `dext.conversationSelections`, `dext.historySortOrder` |
| Session map, active tab, open tab ids, tab ordering | `features/conversations/host/conversationController.ts` | in memory; layout debounce 750 ms |
| Layout write debounce timer | `features/conversations/host/conversationController.ts` | released with the controller |
| Active executions, abort controllers, Code continuations | `features/conversations/host/turnExecutionCoordinator.ts` | in memory, one entry per conversation |
| Buffered agent events and their flush timer | `features/conversations/host/agentEventStream.ts` | in memory, cleared by `dispose()` |
| Pending read-only patches | `features/conversations/host/patchReviewController.ts` | in memory, per turn |
| Pending agent questions and UI forms | `features/conversations/host/interactionController.ts` (two brokers) | in memory, per session/turn/request |
| Plan file text, task progress and verification | `features/conversations/host/planController.ts` + `domain/plan*` | in memory plus `dext.history` progress |
| Browser tab identity, switch ids, render generation, rendered signature | `features/conversations/browser/conversationController.ts` | in memory; reset on switch |
| Cached conversation DOM and its eviction order | `features/conversations/browser/conversationController.ts` (`ConversationViewStore`) | in memory, 6 most recent conversations |
| Composer text and image-attachment drafts per conversation | `features/conversations/browser/composerController.ts` | in memory, one draft per tab |
| Follow-output state, reader gestures and deferred scroll frames | `features/conversations/browser/outputScrollController.ts` | frames cancelled on switch/dispose |
| Turn rows (creation, selection, deletion, cached-row reuse) | `features/conversations/browser/transcriptView.ts` | DOM owned by the rendered view; one map per visible conversation |
| Live Process timeline, tool groups, queued Markdown renders | `features/conversations/browser/agentTraceView.ts` | in memory; isolated during history replay |
| Plan toolbar and the per-turn Plan/open action | `features/conversations/browser/planControls.ts` | rebuilt from host state |
| Diff layout preference, patch review buttons and resolution feedback | `features/conversations/browser/patchReviewView.ts` | DOM + `diffMode`; writing stays a host call |
| Conversation tab strip DOM | `features/conversations/browser/conversationTabs.ts` | rebuilt from the host summary |
| Webview lifecycle, HTML shell, message dispatch, resources/MCP/attachments | `app/sidebarProvider.ts` | VS Code objects |

Narrow ports live in `contracts/`:

- `TurnExecutionHost` — the four application operations a turn may use. No settings, no
  provider discovery, no whole application.
- `TurnInteractionPort` — question/UI ownership by session and turn id.
- `ConversationSessionPort` — the controller is the only writer of the session map; the
  coordinator reports a finished turn instead of mutating tabs.
- `TurnNotifier`, `TurnPatchPort` — publishing and pending patches without an event bus or
  a shared mutable state bag.
- `ConversationHistoryStore` / `ConversationPreferences` — persistence contracts the
  controllers and tests depend on.
- `PlanFileHost` / `PlanSessionPort` (in `host/planController.ts`) — the plan controller
  reads the file and saves progress through these, so it never imports `vscode`.
- `ApplyPatch` is injected into `PatchReviewController`; the host capability that writes
  files lives in `src/platform/vscode/patchHost.ts` and is connected by
  `app/conversationSetup.ts`.

A conversation module never imports `DextApplication`, `DextSidebarProvider`,
`webview/main.ts` or the whole sidebar state. `ConversationSummary` and the conversation
message schema live in `contracts/protocol.ts`, and `src/platform/webviewProtocol.ts` only
composes them.

### Provider session identity

Every execution snapshots the conversation's own Agent controls — profile, model,
reasoning, speed, service tier and permission — into `ExecutionMetadata`. The
application-level selection follows the active tab, so a background Plan round or a fast
tab switch must not run with another conversation's provider.

Provider session ids are stored per provider and are only written from the provider that
reported them. The execution snapshot is the only pairing rule: the profile and the
provider session are both derived from the same conversation selection, so a Harness
`dsh1:...` id cannot reach Codex and trigger `-32600 invalid session id` on
`thread/resume`. No cross-provider fallback is applied, so a provider error is still
reported instead of being silently rewritten.

## Verification (third round)

Results are recorded separately; anything not run is not claimed as passed.

| Check | Result |
| --- | --- |
| `node scripts/checkModuleBoundaries.mjs` | passed — root whitelist, `shared` purity, platform/feature environment direction, `declaredTypeEdges` (6), `crossFeatureHostCouplings` (4), `contracts.ts` ban, browser bundle inputs, and every removed path |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npx vitest run` | passed — 163 files / 1589 tests, with 2 pre-existing skipped files (4 skipped tests) |
| `npm run build` | passed — `dist/webview/main.js`, `main.css`, `project.js` and the other assets keep their names |
| `npm run check` | passed — boundaries, lint, types, tests, build, declaration and API-reference checks, packaged assets |
| `npm run check:ui` | passed — composer, stream jump, conversation scroll, question visibility, editor tabs, Project reader and diagrams |
| `npm run check:ui:conversations` | passed — tabs, delayed scroll, stream jump, question visibility, structured output and the interaction suite |
| `node scripts/monaco-ref-lab/check.mjs` | passed |
| `npm run test:host` | passed — activation, editor tabs, generated types and the Monaco webview verification |

Real Provider smoke tests were **not** run in this round. They need a configured provider,
a temporary workspace and manual interaction; no browser or provider result is claimed.

## What is not in this round

- `sidebarProvider.ts` and `webview/main.ts` remain large entries. This round only moved
  paths, contracts, environment boundaries and the remaining conversation DOM; the next
  round can split resources/MCP/attachments out of the sidebar and history hydration out
  of `main.ts` as behaviour work.
- Agent executors, CLI transports, the workflow kernel, MCP, completion and resource
  editing moved paths but kept their behaviour.
- `core/types.ts` moved to `shared/contracts/types.ts` without splitting its contents.
  The next round can split it per owner and shrink the shared contract surface.
- The next round should start from this document and the records in
  `docs/project-development.md`; do not treat the historical tables as current import
  instructions.

### Shared dependencies kept for this round

`migrationExceptions` is empty: the previous round's remaining dependencies now have an
owner.

| From | To | Why it is allowed |
| --- | --- | --- |
| `features/conversations/domain/planTodoProgress.ts` | `features/agents/domain/agentTodoTracking.ts` | shared todo reducer; feature domain → feature domain is allowed |
| `features/conversations/presentation/historyRender.ts` | `features/workspace/domain/fileReference.ts`, `shared/lib/markdownCopy.ts` | cross-feature domain and the shared kernel |
| `features/conversations/host/historyStore.ts` | `features/workspace/domain/fileReference.ts` | cross-feature domain |
| `features/conversations/host/historyEditorProvider.ts` | `platform/vscode/contextHost.ts` | host → VS Code adapter is allowed |
| `features/conversations/host/uiInteractionBroker.ts` | `shared/contracts/uiForm.ts`, `shared/protocol/executionErrors.ts` | shared kernel |
| `features/conversations/browser/transcriptView.ts` | `features/workspace/domain/fileReference.ts`, `platform/browser/fileReferenceChip.ts` | browser → shared browser primitive; `colorizeSource` is injected by `main.ts` |

The two explicit cross-feature host couplings are registered in
`crossFeatureHostCouplings` (`workflow/host/runtime` → `agents/host/*`, and
`project/host/generation/projectAiGeneration` → `agents/host/cliAxAIService`). The next
round injects those through `app` and removes the table entries.


# Conversation development

This document describes how Dext conversations are put together: which module owns
which state, what each module may depend on, and where the migration moved code from.
It is the current operating guide; historical notes are separated at the bottom.

## Baseline

- Second refactor starts from `a26b4ab` (`fix(conversation): retain token usage in
  completed and historical turns`) with a clean worktree.
- The first wave (Project, Resources, Workspace search, Agent configuration and editor
  tabs) had already been committed. It left 36 modules in `src/` whose only job was
  re-exporting the feature implementation. Those entries are gone; consumers import the
  contract or the implementation directly.

## Removed entries and their targets

Every path below was deleted together with the import update in the same batch. No
alias, mock, build plugin or barrel file restores them: `scripts/checkModuleBoundaries.mjs`
fails on a static import, a type-only import, a literal dynamic load, a mocked
specifier, an inlined build entry string or a restored file.

| Removed path | Target |
| --- | --- |
| `src/agentProfiles.ts` | contracts in `src/features/agents/contracts.ts`, store/helpers in `src/features/agents/host/agentProfiles.ts` |
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

- Agent types and constants come from `features/agents/contracts.ts`; only
  `AgentProfileStore`, `codexConfiguredDefaults` and `modelOptionsFromCodexCache` come
  from the host module. Consumers: `application.ts`, `core/agentRunner.ts`,
  `core/builtinCli.ts`, `core/deepseekHarnessPolicy.ts`, `core/deepseekHarnessRunner.ts`,
  `core/harnessPresets.ts`, `core/runtime.ts`, `core/types.ts`, `webviewProtocol.ts`,
  `webview/main.ts`, `sidebarProvider.ts`, `conversationPreferences.ts` and the
  matching tests.
- Resources are split three ways: contracts (`resourceDocuments.ts`,
  `resourceSession.ts`), host (`resourceEditorProvider.ts`, `apiEditorProvider.ts`,
  `globalResourcesEditorProvider.ts`, `resourceBrowserProvider.ts`) and presentation
  (`resourceDocuments.ts`, `apiPanel.ts`, `globalResourcesPanel.ts`). Consumers are
  `extension.ts`, `application.ts`, `webview/main.ts`, `historyStore.ts`,
  `webviewProtocol.ts`, `sidebarProvider.ts` and the resource tests.
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
| Webview lifecycle, HTML shell, message dispatch, resources/MCP/attachments | `sidebarProvider.ts` | VS Code objects |

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
  files lives in `src/vscodePatchHost.ts` and is connected by `app/conversationSetup.ts`.

A conversation module never imports `DextApplication`, `DextSidebarProvider`,
`webview/main.ts` or the whole sidebar state. `ConversationSummary` and the conversation
message schema live in `contracts/protocol.ts`, and `src/webviewProtocol.ts` only
composes them.

## Verification (this round)

Results are recorded separately; anything not run is not claimed as passed.

| Check | Result |
| --- | --- |
| `node scripts/checkModuleBoundaries.mjs` | passed — 36 removed paths guarded, new conversation boundaries and the listed legacy exceptions accepted |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npx vitest run` | passed — 162 files / 1568 tests, 13 pre-existing skips |
| `npm run build` | passed — `dist/webview/main.js`, `main.css` and the other existing assets keep their names |
| `npm run check` (boundaries, lint, types, tests, build, declaration and API-reference checks, packaged assets) | passed |
| `npm run check:ui` | passed — composer, stream jump, conversation scroll, question visibility, editor tabs, Project reader and diagrams |
| `node scripts/monaco-ref-lab/check.mjs` | passed |
| `npm run check:ui:conversations` | passed — tabs, conversation scroll (delayed scroll and stop-following), stream jump, question visibility, structured output and the full interaction suite including expired-image fallback, secret fields and duplicate submission |
| `npm run test:host` | passed — activation, editor tabs, generated types and the Monaco webview verification (including clipboard) completed |

Real Provider smoke tests were **not** run in this round. They need a configured provider,
a temporary workspace and manual interaction; no browser or provider result is claimed.

## What is not in this round

- The browser split is complete for conversations. Tab identity/cache, drafts, the tab
  strip, scroll, turn rows, the live Process trace, the Plan toolbar and patch review all
  live under `features/conversations/browser/`; `src/webview/main.ts` only wires them to
  the protocol and to out-of-scope UI (resources, MCP, model menus, editor).
  `test/conversationBrowserState.test.ts` and the browser UI checks cover the extracted
  state and DOM.
- Agent executors, CLI transports, the workflow kernel, MCP, completion and resource
  editing are untouched beyond the import changes needed for the removed entries.
- The next round should start from this document and the first-round records in
  `docs/project-development.md`; do not treat the tables there as current import
  instructions.

### Shared legacy dependencies kept for this round

The boundary check lists them as `migrationExceptions`, each with one reason and one
removal condition:

| From | To | Why it stays |
| --- | --- | --- |
| `domain/planTodoProgress.ts` | `src/core/agentTodoTracking.ts` | todo event reducer is shared with the runtime |
| `presentation/historyRender.ts` | `src/core/fileReference.ts`, `src/markdownCopy.ts` | input references and Markdown copy are shared tools |
| `host/historyStore.ts` | `src/core/fileReference.ts` | input normalization at the persisted-data boundary |
| `host/historyEditorProvider.ts` | `src/vscodeContextHost.ts` | file-reference opener |
| `host/uiInteractionBroker.ts` | `src/core/uiForm.ts`, `src/core/executionErrors.ts` | form validation and the cancellation error |
| `browser/transcriptView.ts` | `src/core/fileReference.ts`, `src/webview/fileReferenceChip.ts`, `src/webview/sourceHighlight.ts` | @reference display and composer highlighting are shared with the editor |


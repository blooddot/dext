# Changelog

## UI interaction unification

- Added `ui.select`, `ui.radio`, `ui.checkbox`, `ui.form`, and `ui.alert`, with shared fields and inline/dialog presentation for workflow and Agent questions.
- Kept `ui.input` and `ui.confirm` results and cancellation semantics; added scoped requests, non-secret draft restoration, accessible dropdowns and bounded history summaries.
- **Breaking:** removed `ui.choose`, its host/response protocol and `UiChoiceResult`. Replace calls manually with `ui.radio`, `ui.checkbox`, or `ui.select`; each returns its own result type. Existing history remains readable through a generic fallback and cannot resume a removed interaction.

All notable changes to Dext are documented in this file.

## Unreleased

- Separate long-term project knowledge from per-run conversation Review. Project knowledge lives in `.dext/project.json`, `.dext/objects/*.json`, and `.dext/architecture.json`, and every object now carries independent source, confirmation, validity, and ownership dimensions; the legacy `status` field is migrated on read. Review is keyed by session, turn, and run, and records the project version, plan version, and Build run it was produced against, so feedback can never land on another run or an older attempt.

- Unify Project, API, Global Resources, and History editor tabs behind stable keys, versioned state, and a restore path with a claim guard that prevents a serializer restore and a proactive restore from double-opening a tab. The Project tab exposes only Overview, Knowledge, and Architecture.

- Improve architecture scanning coverage: Python relative imports, `__init__`, and namespace packages resolve; Rust scanning strips comments and string literals before matching, resolves module-tree and `use` relations, and reports conditional compilation and macros as uncertain; `Cargo.toml` description and dependencies are read without running Cargo, optionally enriched by `cargo metadata` with an explicit fallback. `Cargo.toml` is now part of the scanned file set, so a local `use <crate>::x` resolves to that package's `src/lib.rs` or `src/main.rs` instead of being reported unresolved, and the Architecture page lists scan coverage notes, such as an unresolved `Cargo.lock`, separately from unresolved paths.

- Add engineering and experience review presets that change what a review emphasizes, and a local-SVG architecture view that keeps manually declared relations such as a Tauri IPC contract separate from statically detected ones.

- Add `docs/project-development.md` and `docs/project-development.zh-CN.md` describing the project-knowledge and conversation-Review model.

- Show every development turn's Review inside its conversation: the files the run changed, the script facts and coverage it recorded, knowledge drafts, and accept or request-changes actions. A review is bound to its session, turn, and run, an Ask turn or a turn with no change produces no card, and writing a plan produces no implementation review.

- Accumulate Plan builds into one review bound to the plan content version and Build run. Proven task associations are grouped by task ID, while shared and unattributed changes are listed separately instead of being inferred from the agent's task checkmarks, and the final acceptance waits for the user instead of letting the Agent continue.

- Add a knowledge adoption bridge: each pending draft has its own **Adopt** action that writes one long-term object and opens it in Project. Accepting the code review stays a separate action and writes no project knowledge.

- Move the API directory and Global Resources out of sidebar dialogs into editor tabs. Search, namespace grouping, detail, reference insertion, source jumps, categories, and refresh are preserved, and reopening the same target reveals the existing page. `dext.editResource` opens the existing resource edit flow for a kind and scope.

- Read the plan's Review preset default synchronously from the cached project definition, so a send freezes the effective preset without waiting on file I/O.

- Let `ui.form` declare several submit buttons through `actions`, each with its own `id`, optional `primary` highlight and `requires` list of fields it needs answered; the pressed button comes back as `action`. A decision that used to need a radio field plus a conditional text box is now one button per outcome, and the form no longer reports unmet requirements before the user has pressed anything.

- Restyle workflow and Agent interaction cards and dialogs: scrollable descriptions, selectable option rows, a pinned borderless close button, a separated action bar and a distinct primary button.

- Show the Claude CLI default model in the composer instead of "CLI setting" when it is configured through `env.ANTHROPIC_MODEL` in `settings.json`, and display configured model slugs such as `claude-opus-5` under their composer alias ("Opus").

- Render the built-in type/API reference documents and editor hovers as valid Python: use `X | None` instead of the unsupported `?:`, `list[T]` instead of `T[]`, and treat always-present interaction fields such as `UiFormResult.type` as required.

- Default Dext to the Secondary Side Bar while preserving user-customized view locations. Require VS Code 1.106 or newer for the native view container contribution.

- Simplify completion to its active generation/cancellation interface; remove unused result conversion and editor/runtime helpers. Enable TypeScript checks for unused locals and parameters.

- Remove ChatGPT-authenticated Tab completion, its login commands, settings and dedicated runtime. Preserve sidebar Codex conversations and API Key/Ollama completion. Clean up the unreleased preview settings locally and remove the temporary ChatGPT Tab migration code; retain CLI authentication compatibility and existing HTTP settings and credentials.

- Let explicit completion-evaluation commands return bounded, sanitized reports without a picker. Report missing credentials separately from endpoint/model configuration and distinguish readable storage, global credentials and legacy-key presence without exporting secrets.
- Add cancellable completion evaluation inside the active VS Code Profile, using existing SecretStorage credentials without exporting them or changing automatic-completion settings. Share candidate and saved-example evaluation with the CLI; extend coverage to 34 cases.

- Connect Codex conversation questions to inline Dext cards above Process, with choices, custom answers and submission status. Use App Server for interactive conversations, support blocking and asynchronous questions, and close stale requests on completion or cancellation.

- Continue unfinished Plan executions across Agent turns, preserve round checkpoints and require a separate final verification. Show incomplete, blocked and user-stopped outcomes accurately in live and restored history, with bounded continuation and explicit resume.

- Let active Codex, Claude, and DeepSeek Harness turns run beyond one hour: default to an activity-based idle timeout, with an optional total time limit and distinct timeout messages.
- Preserve HTTP/Ollama completion configuration while adding background context, dependency-scoped caches, bounded candidate checks and same-line identifier replacement.
- Add observable acceptance/undo feedback, session adaptation and opt-in versioned workspace memory with decay, capacity limits and clear controls. Actual model quality improvement still requires acceptance testing.
- Add 32 complete-edit fixtures, eight feedback sequences and shared-production offline probes. Fix long-line candidate matching that produced quadratic scanning. Report core timings separately from editor and real-model latency.
- Add alternating Git-revision baselines, bounded stage diagnostics and independent clear-generation markers so stale workspace-state writes cannot restore cleared project experience.
- Invalidate memory and candidates before asynchronous clearing, retry transient persistence failures, reject invalid stored timestamps, and verify cross-process clear generations and restart recovery using real VS Code storage. Add opt-in editor benchmarks and separate provider-to-send timing from model and account checks.

## 0.1.1 - 2026-09-09

Initial release.

- Clarify the Marketplace summary with supported agents and reusable workflows.
- Add a sidebar name, icon, and focus command declaration.
- Remove redundant activation events generated automatically by VS Code.
- Read MCP client identity from the extension manifest and centralize protocol versions for stdio and HTTP.

- Add DeepSeek Harness 0.1.2-rc.1 as the third Agent backend over ACP SDK 1.4.0, with model discovery, bound resumable sessions, permission scopes and typed workflows.
- Remove AIOA/CDP integration and its dependencies without legacy conversation compatibility.

- Use PolyForm Perimeter License 1.0.1, with separate commercial licensing available by agreement. Third-party components retain their own licenses.
- Typed Dext workflow editor and built-in APIs.
- Codex and Claude Code agent profiles.
- Workspace references, custom APIs, Skills, and MCP tool calls.
- File-private typed helper functions in `.dx` APIs, with isolated call scopes and editor assistance.
- Go to Definition for `.dx` imports, API calls, aliases, and file-private helper functions.
- Preserve returns from exception handlers and report function fallthrough without executing skipped returns.
- Typed output, history, and user interaction controls.

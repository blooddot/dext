# Changelog

## UI interaction unification

- Added `ui.select`, `ui.radio`, `ui.checkbox`, `ui.form`, and `ui.alert`, with shared fields and inline/dialog presentation for workflow and Agent questions.
- Kept `ui.input` and `ui.confirm` results and cancellation semantics; added scoped requests, non-secret draft restoration, accessible dropdowns and bounded history summaries.
- **Breaking:** removed `ui.choose`, its host/response protocol and `UiChoiceResult`. Replace calls manually with `ui.radio`, `ui.checkbox`, or `ui.select`; each returns its own result type. Existing history remains readable through a generic fallback and cannot resume a removed interaction.

All notable changes to Dext are documented in this file.

## Unreleased

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

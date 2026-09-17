# Changelog

## UI interaction unification

- Added `ui.select`, `ui.radio`, `ui.checkbox`, `ui.form`, and `ui.alert`, with shared fields and inline/dialog presentation for workflow and Agent questions.
- Kept `ui.input` and `ui.confirm` results and cancellation semantics; added scoped requests, non-secret draft restoration, accessible dropdowns and bounded history summaries.
- **Breaking:** removed `ui.choose`, its host/response protocol and `UiChoiceResult`. Replace calls manually with `ui.radio`, `ui.checkbox`, or `ui.select`; each returns its own result type. Existing history remains readable through a generic fallback and cannot resume a removed interaction.

All notable changes to Dext are documented in this file.

## Unreleased

- Show the Dext question card for a DeepSeek Harness `ask_user_question`, and for ACP elicitation. The Harness runner asked Dext's UI for the answer but never published the `waiting` / `answered` / `dismissed` input event the Codex runner uses to render and close that card, so the tool call parked the turn with nothing on screen to answer - even though the private question channel and the preset overlay were wired correctly. Secret answers are still never echoed into the transcript.

- Report `.dx` problems where they are written. The loader no longer joins its errors into one positionless string: each diagnostic keeps its file, line, column, stable code (`dext/compile`, `dext/must-return`, `dext/unknown-api`, `dext/reassign`, `dext/missing-rule`, `dext/signature`, `dext/syntax`, `dext/cycle`, `dext/duplicate-api`, `dext/mcp`, …), and API id, every independent error in a file is reported instead of just the first, and one failing file no longer hides the rest. `.dx` files now write to the **Problems** panel as you type (debounced), including from an unsaved buffer; **Dext: Check All APIs** checks the whole project into the same collection and the **Dext API Check** output channel with an `N error / M warning` summary; **Reload APIs** reports the same details; and entry is cleared when its file is deleted, even while its editor tab is still open. Each diagnostic also names the function it is in. A dependency cycle is named on the APIs that actually form it instead of being repeated on every loaded API.

- Name the missing MCP tool instead of its root. A call to an unregistered `mcp.<server>.<tool>(...)` compiled the `mcp` root as a variable and reported `Unknown variable 'mcp'.`, which hid which tool was missing; the API path now resolves and reports `Unknown Dext API 'mcp.<server>.<tool>'`.

- Report why a custom API call failed. A registered API whose function body did not compile used to fail with a bare `Custom API 'dev.fix' is not available.`; it now names the file, the function, the reason, and the line, says the method is registered but its body failed to compile, and distinguishes a declared MCP tool whose server is not connected from a plain unknown name and from an untrusted workspace that disabled custom APIs.

- Fix the `.dx` examples in the README and the workflow reference: built-in APIs are always in scope, so `from common import ask` never resolved and the copied example failed to load. The `Imported API 'common.ask' is not defined.` error now names the direct call to write instead.

- Fix `def main() -> McpRawResult` being rejected with "must return mcpRaw result": the return-kind check compared a camelCase kind (`mcpRaw`) against a lowercased PascalCase type name (`mcprawresult`). The unresolved-name squiggle in expression position also now covers the callee instead of its argument list, and a failed return expression no longer repeats itself as "A custom API function must return a value."

- Fix Harness session restore, which failed every resumed conversation with the protocol's generic `Internal error`: Dext's preset plugin forwarded only the agent-context argument to the deepseek Harness agent factory's `setup`, dropping the agent the resume path composes its model selection from.

- Report the cause behind a generic Harness `Internal error` — the ACP error's `data` payload plus the process's stderr tail — instead of the placeholder, and continue in a new session whose prompt carries this conversation's own context when the Harness refuses to restore a stored one, saying so in Process.

- **Breaking:** the Harness **Agent preset** menu now lists exactly the installed Harness catalog, with no Dext-only **ACP default** entry: every Harness conversation mounts a preset, and an unset or previously empty selection runs Standard instead of the profile's own agent composition.

- Add text and value expressions to the workflow language: string concatenation with `+`, Python f-strings with conversions (`!r`), format specs (`.2f`, `,`, `>8`), nested specs and `{value=}`, `%` formatting, `str.format`, indexing and slicing (`text[1:4]`, `text[::-1]`), membership tests, ordering comparisons, `and`/`or`/`not`, Python string methods, and the pure helpers `len`, `str`, `repr`, `int`, `float`, `bool`, `abs`, `round`, `min`, `max`, `sorted`, `sum`, `range`, `list`, `reversed`, `any`, and `all`. A value the compiler can determine is folded while compiling, so `"a" + "b"` behaves exactly like `"ab"` in every check; everything else stays a pure runtime expression with no API round trip. `elif` chains now keep every condition instead of quietly running the first body.

- Accept Python tuple syntax as list syntax: `("a", 1)`, `(value,)`, `()` and the bare `1, 2` all compile to a list, so `startswith((".md", ".txt"))`, `"%s %d" % ("total", 3)` and `"%s" % (items,)` can be written exactly as in Python. There is still one sequence type: a tuple is not fixed-length and `(1, 2) == [1, 2]` is true, and unpacking stays unsupported (`a, b = pair` reports that Dext assigns one variable at a time).

- **Breaking:** reject assignment shapes that used to compile by dropping part of the statement: `a, b = value` lost the extra name, and `a = b = 1` bound only `a`. Each now reports the shape it does not support. `x = 1, 2` used to silently bind only `1`; it now compiles as the tuple Python sees, which is a list.

- Parse Codex `config.toml` with `smol-toml` instead of line regexes, so comments, sections, and string escapes no longer break CLI path and model defaults.

- Add `agent(patch=false)` for text-only previews that report conclusions without producing a patch; route Agent result parsing through one tolerant boundary with one bounded ax-driven repair attempt, and return the harness final message instead of throwing "returned invalid JSON" so failures stay diagnosable.

- Separate long-term project knowledge from per-run conversation Review. Project knowledge lives in `.dext/project.json`, `.dext/objects/*.json`, and `.dext/architecture.json`, and every object now carries independent source, confirmation, validity, and ownership dimensions; the legacy `status` field is migrated on read. Review is keyed by session, turn, and run, and records the project version, plan version, and Build run it was produced against, so feedback can never land on another run or an older attempt.

- Unify Project, API, Global Resources, and History editor tabs behind stable keys, versioned state, and a restore path that keeps one panel per key. A page persists its own state, so reopening a window restores the same page and target, and a panel restored without usable state is rendered or dropped instead of being left blank. The Project tab exposes only Overview, Knowledge, and Diagrams.

- **Breaking:** remove the source scanner (TypeScript/JavaScript, Python, Rust and `Cargo.toml`) and the per-format diagram adapters (draw.io, Mermaid, Structurizr). Project knowledge now comes from an explicit, user-triggered AI initialization over a bounded, redacted evidence package, and one pinned Archify runtime renders all five diagram kinds from Project's own semantic IR. HTML and SVG are the only export formats.

- Add a **Diagrams** page that embeds the rendered Archify viewer in a sandboxed frame: select a saved diagram, generate or update one from a requirement, refresh, export HTML/SVG and go fullscreen, with validation, version and evidence coverage in a collapsed section. A failed render keeps the same diagram's last successful result visible and labels which version is on screen.

- Add declared architecture rules: `.dext/architecture.json` may carry `diagramId` and `rules` (`deny`, `allow`, `no_cycles`) over stable Project node ids, and the Diagrams page lists those rules with the violations the saved diagram currently has. Rules that cannot be evaluated against a diagram are reported instead of being applied to a guess.

- Persist the last successful render of each diagram in `.dext/diagram-history.json`, newest first and bounded in size, so a later failed render can still show the previous result after a window reload instead of only within one session.

- Add engineering and experience review presets that change what a review emphasizes.

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

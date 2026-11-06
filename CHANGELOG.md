# Changelog

All notable changes to Dext are documented in this file.

## 0.1.2 - 2026-11-03

- Pi runs the packages installed with `pi install`: the composer's **Plugins** row picks them per conversation, and a read-only turn blocks `write`, `edit`, `bash` and `powershell`.
- A Plan turn's Todo panel is driven by Pi's `dext_update_todos` tool, and each task is reported as soon as its verify step passes.
- `dext_fetch` gives read-only turns a web reader that refuses credential-bearing, loopback, private and link-local targets, follows at most 5 redirects and returns at most 512 KiB.
- Pi's shipped `agent_before_settle` hook asks once for `dext_submit_result`, and a read-only Harness turn that answers in Markdown returns the `agent` result instead of aborting.
- Pi appears in the composer by default: `dext.agentCli` now offers `codex`, `claude`, `deepseek-harness` and `pi`.
- A tool call that never reports a result stops the turn after thirty minutes, and an active Codex, Claude or Harness turn runs past one hour while it keeps working.
- DeepSeek Harness desktop starts through its own launcher with `--expose-internals`, keeps its startup log as stderr, and lists presets from the shipped `presets/*.patch.yml`.
- Models added in the DeepSeek Harness app now appear in Dext: `llm-pi-ai`, `llm-deepseek` and `agent-default-model` merge from `cordis.patch.yml`, with `settings.yaml` winning per field.
- A new turn starts with **Process** collapsed like stored History, its summary keeps the live `Thinking for …` duration with token and command counts, and Harness adds `12k/1M context`.
- **Breaking:** DeepSeek Harness 0.1.x is gone, so **Manage presets** offers only **Refresh presets**. Replace presets in `$DSH_HOME/.agent-presets` with app-created ones.
- A Harness `Internal error` reports the ACP data payload and the stderr tail, and Codex `config.toml` is parsed with `smol-toml` so comments and escapes no longer break defaults.
- Codex conversation questions render as inline Dext cards above Process, the Harness `ask_user_question` and ACP elicitation reuse it, and a question Dext cannot render is answered as unavailable.
- Conversation history lives in files under `<storageUri>/conversation-history/`, imported once from `dext.history*`, and `dext.history.maxOutputLength` now defaults to `64000`.
- **Breaking:** an API's entry function must be named after its file; `main` is no longer recognised. Replace `export async function main` with the file's own name and update its imports.
- The API **Execution flow** is the entry function's own statements, with decisions, loops, `try` and one end node per returning branch; `break` and `continue` keep their arrows.
- **Breaking:** the `.dx` language is removed with its grammar, diagnostics and `node.*` bridges. Run `node scripts/migrateDxToTs.mjs` and import the TypeScript module instead.
- **Breaking:** `chat`, `print`, `text`, `code` and `patch` are removed, and the result kinds are trimmed from 14 to 9. Replace `print(text)` with `console.log(text)`.
- Code mode runs as real TypeScript in a long-lived Node child process, and `dext.workflow.maxConcurrency` caps concurrent API calls.
- A Code run stays open while it waits for a Dext API, and after a failure it resumes at the call boundary: a call whose fingerprint still matches returns its recorded response.
- Functions, symbols, bigints, non-finite numbers, `Map`, `Set`, `Buffer` and cycles are refused at the kernel boundary with the path named, and a `Date` becomes an ISO string.
- The generated `dext` project is committed: commit `.dext/api/dext.d.ts`, `.dext/tsconfig.json` and `.dext/package.json`.
- An API reload rewrites `dext.d.ts`, `tsconfig.json` and `package.json` under `.dext/` with `@types/node`, and the declaration lists `skills`/`rules` and types each project MCP tool.
- `dext/api/<id>` imports resolve in the generated project, the directories in `dext.apiDirectories` are mapped from `.dext/`, and the composer resolves them through virtual files.
- The composer uses real TypeScript, so completion, hover, diagnostics and go to definition work in Code mode, and completion is offered in Code mode only.
- **Dext: View APIs** lists the Node and JavaScript API reference generated from the declarations, and a Code turn's input is colorized by the composer's grammar and theme.
- A result whose contract declares a string array is repaired instead of failing, so a workflow no longer aborts on that result shape.
- `template(input, source, values)` renders text from a Dext template whose front matter declares its fields, so no section can be added or reordered, and it writes nothing.
- **Breaking:** an Agent patch is applied before the result returns; Accept/Reject cards, diff views and `dext.diff.defaultView` are gone. `agent(patch=false)` still returns text-only.
- Every Resources category groups by directory, and discovery reads file-based APIs, rules, skills and MCP manifests without executing them.
- MCP tools are filed under **MCP** on the Resources page with per-node counts, and `dext.viewMcp` is now `dext.viewResources`.
- The API directory and Global Resources open as editor tabs like History, and each panel key restores its own page and target after a reload.
- **Breaking:** `dext.apiDirs`, `dext.skillDirs` and `dext.plan.directory` are renamed to `dext.apiDirectories`, `dext.skillDirectories` and `dext.planDirectory`, and `dext.mcpDirectories` is new.
- **Breaking:** source-file inline completion, its settings, evaluation commands and stored feedback are removed; remove the `dext.completion*` entries from `settings.json`.
- **Breaking:** `ui.choose` and `UiChoiceResult` are removed; use `ui.radio`, `ui.checkbox` or `ui.select`. `ui.alert` and `ui.form` are new, and `ui.form` takes `actions`.
- A settled question card keeps every option it offered, marks the picked rows, shows a typed reply as its own `Other` row and accepts a multi-select answer.
- The **Output Language** setting applies to Code mode: `agent()` and `ask()` calls from workflow code get the same instruction, and machine-readable output is never translated.
- The terminal timeout setting now matches runtime behaviour: 120,000 ms by default and 600,000 ms maximum, with an invalid value falling back to the default.
- Ctrl+C is left to VS Code wherever VS Code copies, Dext claims only `ctrl+shift+c`, and `dext.copyFilePathWithFiles` keeps copied files pasteable in Explorer.
- Importing a bare GitHub repository URL installs its latest published release, and **Update Skill pack** compares and reports added or removed skills.
- The project ships `release.audit`, `release.changelog`, `release.notes` and `docs.sync` APIs with their `release-*` and `docs-*` rules, plus imported skill packs under `.dext/skills`.
- Dext defaults to the Secondary Side Bar while preserving user-customized view locations, and requires VS Code 1.106 or newer.
- A Plan execution continues across Agent turns with round checkpoints and a separate final verification, and live and restored history show incomplete, blocked and user-stopped outcomes.
- A screenshot annotation tab zooms like a picture viewer: a bar with zoom, **Fit**, **1:1**, pixel size and **Hide annotations**, plus Ctrl/Cmd + wheel around the pointer.
- A Code run keeps every API result out of Output by default; pass `echo: true` on an `ask`, `plan`, `agent`, `template` or `skill` call to show it.

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

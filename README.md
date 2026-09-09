# Dext

English | [简体中文](README.zh-CN.md)

Dext is a Visual Studio Code extension for AI conversations and typed workflows. Ask questions, delegate code changes, and work through implementation plans. Turn repeated tasks into reusable workflows with APIs, Skills, and MCP tools.

![Dext in the VS Code sidebar, explaining the selected Playground code](docs/images/dext-overview-sidebar.png)

<details>
<summary>View the fullscreen layout</summary>

![Dext expanded to the fullscreen layout](docs/images/dext-overview-fullscreen.png)

</details>

## What you can do

| Mode | Use it to | Input |
| --- | --- | --- |
| **Ask** | Understand code and explore questions without changing files | Natural language |
| **Agent** | Implement features, fix bugs, and run checks | Natural language |
| **Plan** | Create and revise a plan, then click **Build** to implement it | Natural language |
| **Code** | Compose API calls into typed workflows | Workflow code |

Plan execution checks reported task progress after every response and continues unfinished, actionable work. Once all tasks are reported complete, Dext requests a separate final verification before displaying `Completed`. Round checkpoints are saved in conversation history without editing the plan document. Clicking **Build** again restores matching tasks from the same plan.

User cancellation displays `Stopped`; explicit external blockers covering every remaining task display `Blocked`. Three consecutive rounds without new completed tasks or new tool activity, or the 64-round execution ceiling, stop with `Incomplete` and preserve the plan. A normal Agent return no longer implies completion. Final verification relies on the Agent inspecting the implementation and checks; task reports alone cannot independently prove correctness.

Add files and selections as context, revisit conversations in History, and record a conversation as a starting workflow. Code mode provides API completion, parameter hints, diagnostics, and typed result fields.

Drag files from the VS Code Explorer, hold **Shift**, and release over the highlighted Dext input to insert file references at the drop position. You can drag multiple selected files together.

Dext supports **Codex CLI, Claude CLI, and DeepSeek Harness**. You can also configure an optional, separate model for inline code completion.

## Installation

Requires **VS Code 1.105 or newer**. For AI tasks, install and authenticate one of the supported Agent CLIs; Dext uses that CLI's credentials.

### Install from the Marketplace

1. Open the Extensions view in VS Code.
2. Search for `blooddot.dext` and select **Dext** by **blooddot**.
3. Click **Install**.

You can also open the [Dext Marketplace page](https://marketplace.visualstudio.com/items?itemName=blooddot.dext). Manage updates from the Extensions view.

### Install from VSIX

1. Download `dext-<version>.vsix` from [GitHub Releases](https://github.com/blooddot/dext/releases).
2. Open the VS Code Command Palette and run **Extensions: Install from VSIX...**.
3. Select the downloaded file and reload VS Code if prompted.

To update a manual installation, install the new VSIX. To build from source, see [Development](docs/development.md).

## Quick start

1. Open your project folder in VS Code. Click Dext in the Activity Bar or run **Dext: Focus Input**.
2. Choose an Agent and model in the input area; expand **More options** if needed. Use **Dext: Configure Agent** to change the executable path.
3. Select **Ask**, enter “Explain the structure of this project,” and click **Send**. To ask about specific code, select it in the editor and use **Add to Dext**.
4. Select **Agent** when you want changes. Use **Workspace write** for edits within your project; **Full access** allows broader access.

For a larger task, select **Plan** to create and revise an implementation plan. Select the final plan and click **Build** in the same mode to execute it.

![Select code, add it to Dext, and ask for an explanation](docs/images/dext-ask-demo.gif)

*Ask in action: select code → Add to Dext → “Explain the selected code.”*

## Write a workflow

Select **Code**, enter the following, and click **Run**:

```python
answer = ask(input="Explain the structure of this project")
print(text=answer.text)
```

Workflows use a small subset of Python syntax, parsed and validated by Dext. **No Python interpreter is required.** API parameters and result fields have completion and type checking.

Save reusable APIs as `.dx` files under `.dext/api/`. For example, create `.dext/api/team/analyze.dx`:

```python
from common import ask

def main(input: str) -> ChatResult:
    return ask(input=input)
```

In Code mode, call `team.analyze(input="...")` directly, or import a shorter name:

```python
from team import analyze

answer = analyze(input="Explain task filtering and its tests")
print(text=answer.text)
```

Project APIs require a trusted workspace. You can also right-click a History entry and choose **Record Conversation as Dext Workflow** to generate a starting point for editing. See the [workflow and API reference](docs/workflows.md) for composition, Skills, rules, and UI confirmations.

<p align="center">
  <a href="docs/images/dext-workflow-completion.png"><img src="docs/images/dext-workflow-completion.png" alt="Code mode offering TerminalResult fields while typing checked. after a Playground API call" width="560"></a>
</p>

*Field completion while typing `checked.`. The `playground.*` APIs shown here come from Dext Playground.*

## Learn with Dext Playground

[Dext Playground](https://github.com/blooddot/dext-playground) is a small Todo application with guided exercises. Start by running the app, asking Dext about its code, and making one visible change. Continue with planning, feature development, testing, reusable APIs, and MCP tools when you are ready.

[Start the tutorial](https://github.com/blooddot/dext-playground/blob/master/docs/en/getting-started.md).

![Playground after the Agent search exercise, with a matching task, global counts, and the change summary](docs/images/playground-search-result.png)

*After completing the search exercise: the list matches the search query while global task counts stay unchanged.*

## Documentation

| Guide | Contents |
| --- | --- |
| [Workflows and APIs](docs/workflows.md) | Syntax, built-in and custom APIs, context, Skills, rules, and History |
| [Agent configuration](docs/agents.md) | CLI setup, model overrides, and DeepSeek Harness presets and permissions |
| [MCP configuration](docs/mcp.md) | Tool manifests, typed results, transports, and credentials |
| [Inline completion](docs/completion.md) | Model setup, API formats, and tuning |
| [Development and releases](docs/development.md) | Local development, checks, packaging, publishing, and architecture |

## Completion: API models, context and project experience

Tab completion supports API Key models and local Ollama. ChatGPT sign-in for Tab completion has been removed; sidebar Codex conversations are unaffected. The unreleased preview settings were cleaned up locally; the extension carries no ChatGPT Tab migration code. Use **Dext: Configure Completion Model** to configure an API model. Codex CLI continues to manage its own login. Completion now uses bounded nearby text and background definitions, recent edits and relevant saved-code references. Queries never extend the debounce wait; cold or unavailable context falls back to the local window after ignore rules are loaded. All source snippets follow workspace boundaries, `.dextignore` and the configured `.gitignore` policy. Suggestions support single-line identifier replacement and bounded multi-line insertion.

`dext.completion.adaptation` supports `off`, `session` (initial default) and `workspace`. The completion menu provides mode selection, a memory summary and **Clear this project's completion memory**. `workspace` persists local weak-feedback statistics and validated references, never raw code copies or feedback logs sent to a training service. `off` stops using and collecting experience; switching to `session` clears stored experience for the open workspace roots. Accepted code is observed for 30 seconds; only attributable undo, modification or saved retention contributes. At least 20 effective observations precede long-term adjustment, limited to ±20%. Old observations decay; records expire after 30 days. Workspace mode remains opt-in until held-out quality and latency comparisons justify making it the default.

Memory uses VS Code `workspaceState`, which resides on the extension host (including a remote host when applicable). Each root has eight fixed storage slots, each capped at 16 statistics groups, three references and 16 KiB; at most eight roots are active per window. Writes coalesce every 30 seconds. Random clear-generation markers are stored separately in `<Dext global storage>/completion-memory-generations`; they contain no source or account details. A stale whole-`workspaceState` write cannot roll these markers back. Windows invalidate their snapshots when they observe marker changes; unavailable markers disable persisted memory until verified. Clearing immediately invalidates local memory and candidates before disk work; a failed clear stays unreadable until retried. Transient writes are retried in a later batch. VS Code provides no cross-window transaction, so slot collisions and concurrent writes can still lose recent statistics. Shutdown flushing is best effort. Integration tests verify shared clear markers across two actual VS Code processes with separate profiles, stale Memento replay, and persistence after restarting the peer profile.

Existing HTTP settings in the active VS Code Profile can be evaluated with **Dext: Evaluate Completion Quality and Latency**, also available in the completion menu. Choose three quality rounds, three adaptation modes, or 100 latency samples. The command resolves configuration for the current document and reads the existing SecretStorage key inside the extension process; it never exports credentials through arguments, logs or temporary files. Explicit evaluation works when automatic suggestions are disabled, without changing settings, switching backends or training your actual project memory. Cancel at any time; authentication failure, rate limiting and unavailable backends stop the remaining batch. Editor reports contain metrics, not raw model output. Windows running an older extension must load the new build to use the command; no repeat authorization is needed.

Offline verification (no account or model requests):

```sh
node scripts/probeCompletionApi.mjs --offline --cases test/fixtures/completionQuality.json
node scripts/probeCompletionApi.mjs --offline --adaptation --cases test/fixtures/completionAdaptation.json
node scripts/probeCompletionApi.mjs --offline --performance --repeat 200
node scripts/probeCompletionApi.mjs --offline --performance --repeat 200 --baseline-revision 53ccfd28e6213ca967b12023c7d6d7fac06a1048
```

The independent CLI supports `--backend http --endpoint <base> --models <id> --api <effective-format> --quality --repeat 3` with `DEXT_PROBE_KEY` in the environment. It does not load the active Profile or SecretStorage; prefer the editor command for existing configuration. A missing CLI environment variable does not mean the extension is unconfigured. Preserve the configured `openai`, `openai-chat`, `anthropic` or `ollama` format; do not infer it from the model name. Use `--suffix` for paired suffix evidence. CLI quality evaluation prints fixture model text and edited candidates, so review output before sharing it. There are now 34 complete-edit fixtures and eight feedback sequences, including saved-example and restart tasks using production reference validation. Fixed responses and supplied weak feedback prove processing behavior, not model improvement. Core timings exclude editor scheduling, network latency and painted ghost text. Real held-out adaptation benefit remains unverified.

`--baseline-revision <full commit SHA>` loads the previous HTTP provider from Git in memory and alternates previous/current runs without changing the checkout. It also supports `--quality`.

### Completion validation

Completion validation on Windows (2026-09-09): 96 fixed-response edits over three rounds produced 75 valid / 9 wrong / 12 empty results at baseline `53ccfd28e6213ca967b12023c7d6d7fac06a1048`, and 84 / 0 / 12 with the current pipeline. These are candidate-processing results, not evidence that a real model learned. Actual VS Code provider benchmarks (200 samples per scenario, alternating versions, fixed HTTP responses) recorded:

| Scenario | Baseline p95 | Current p95 | Model calls, baseline/current |
| --- | --- | --- | --- |
| Warm candidate cache | 0.047 ms | 0.442 ms | 1 / 1 |
| Uncached positions | 16.444 ms | 16.841 ms | 200 / 200 |
| Overlapping provider calls | 16.448 ms | 16.382 ms | 400 / 200 |
| Large file | 16.200 ms | 16.212 ms | 200 / 200 |
| File switching | 16.072 ms | 16.482 ms | 200 / 200 |

Run the opt-in editor benchmark in PowerShell with `$env:DEXT_COMPLETION_PERFORMANCE='1'; npm run test:host`. It requires the baseline Git commit and creates temporary fixtures/profiles; it uses real document reads and scheduling but does not measure network, model learning, or screen paint. Clear the environment variable afterward to run only ordinary host checks. Diagnostics now associate provider/edit timestamps with actual HTTP dispatch and label backend preparation separately.

Explicit calls to `dext.evaluateCompletion` may supply `quality`, `adaptation`, or `performance`; the command still uses the effective Profile configuration and fixed request limits, and returns only sanitized summaries. Missing-credential reports distinguish readable storage, global-key presence, current legacy-key presence and the count of other legacy completion keys, without returning values or key names. A 2026-09-09 Cocos Profile development-window check found the configured model/protocol/endpoint but no global or legacy completion credential in readable SecretStorage: 0 of 102 quality requests were sent. This is not a failed model-quality score. Existing provider or agent credentials are never substituted automatically.

## Feedback and license

Report bugs or request features in [GitHub Issues](https://github.com/blooddot/dext/issues). Include the Dext and VS Code versions, reproduction steps, and relevant logs with credentials removed.

Dext is source-available under the [PolyForm Perimeter License 1.0.1](LICENSE), with separate commercial licensing available by agreement. Ordinary use, including internal business use, is permitted subject to the license. Using Dext to provide a competing product or service to others requires separate authorization, even if that offering is free.

See [commercial licensing](COMMERCIAL-LICENSING.md) for the scope and how to request an agreement. This is a source-available license, not an OSI-approved open-source license. Third-party components retain their own licenses. See [CHANGELOG.md](CHANGELOG.md) for version notes.

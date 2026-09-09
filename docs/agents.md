# Agent configuration

English | [简体中文](agents.zh-CN.md)

[Back to README](../README.md)

Dext supports Codex CLI, Claude CLI, and DeepSeek Harness. Install and authenticate your chosen CLI, then select the Agent and model in Dext. Run **Dext: Configure Agent** to change executable paths.

Codex conversations use the CLI's App Server to show native questions as cards above Process. Select an option or type an answer, then submit; asynchronous questions let the agent continue working while you answer. Completed or interrupted turns close unanswered cards, and history shows read-only answers. Existing text-only questions cannot be answered retroactively. This uses your normal Codex login and configuration, independently of Dext's completion account. Interactive conversations accept `--config`, `--enable`, and `--disable` overrides in `dext.agentCliArgs`; other CLI flags produce an explicit configuration error. Typed `.dx` APIs continue using `codex exec`.

[General configuration](#general-configuration) · [DeepSeek Harness](#deepseek-harness)

## General configuration

Agent profiles are stored in VS Code extension global storage. The input area exposes Agent, Model, Reasoning, and Speed selectors where supported by the provider. Codex profiles read the local Codex model cache when available, including supported reasoning levels and speed tiers. Claude Code profiles use its native `opus`/`sonnet` aliases and configured effort levels. A `.dx` file may override the Agent and Model with `@api(agent="codex", model="...")`; otherwise the input selection is used. `Dext: Configure Agent` edits executable commands and custom model labels without handling credentials.

The built-in `agent`, `ask`, `plan`, `skill`, and `create` APIs also accept optional per-call `cli` and `model` arguments. `cli` is `"codex"`, `"claude"`, or `"deepseek-harness"`; see below for the Harness model object. For Claude, `model` is `"sonnet"` or `"opus"`; for Codex it is a dictionary with a required `model` ID from the configured Codex model list, optional `reasoning` (`"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"`), and optional `speed` (`"standard"`, `"fast"`). The selected model must support the requested reasoning level and Fast mode. If no local model list is available, Codex IDs are accepted as strings until the catalog is available.

```python
ask(input="Explain this code", cli="claude", model="sonnet")
agent(input="Implement the change", cli="codex")
```

Omit both `cli` and `model` to use the current Input selection (existing `.dx` decorator overrides still apply). Providing only `cli` uses that CLI's own default configuration, without inheriting Input or decorator model, reasoning, or speed settings—even when the CLI matches Input. Providing both uses the explicit model options and leaves omitted reasoning/speed options to the CLI defaults. Providing only `model` uses Input's selected CLI; unspecified options retain Input settings when the model is unchanged, otherwise they use CLI defaults. These overrides apply only to the current call. Codex Speed controls Standard/Fast processing directly.

The `dext.agentCli` setting controls which built-in Agent profiles are shown in the composer. It defaults to `codex`, `claude`, and `deepseek-harness`; edit the list to choose which of these profiles to display.

Built-in APIs are always available. Code input accepts qualified custom API calls and explicit imports. In `.dx` files, custom APIs are scoped by `import` or `from ... import ...` statements. Completion, hover, signatures, and compilation support imported names.

### Turn timeouts

Dext defaults to `dext.agent.timeoutMs: 0` (no total time limit) and `dext.agent.idleTimeoutMs: 600000` (ten minutes without process output while no tool is reported active). Each stdout or stderr chunk restarts the idle timer. Codex, Claude, and ACP tool start events pause idle detection; after every outstanding tool completes or fails, a fresh idle interval starts. Concurrent tools and duplicate lifecycle events are tracked by call ID. Silent commands are therefore not mistaken for a stalled model while their tool call remains active.

Tool execution retains its provider-specific limits. A reported active tool is not proof that its process is healthy: a hung tool or a missing completion event can keep idle detection paused. Stop and an explicitly configured total time limit remain effective. If a provider does not report an identifiable tool start, the ordinary idle timeout still applies.

Set either value to `0` to disable that limit. An explicitly configured positive `dext.agent.timeoutMs` remains a hard limit regardless of output; remove an old override or set it to `0` to use activity-based timing alone. Changes apply to new turns, and Stop remains available. Provider network timeouts and individual tool timeouts remain independent.

## DeepSeek Harness

### Installation and models

Install the tested release with `npm install -g @deepseek-ai/dsh@0.1.2-rc.1`. Configure its model credentials using Harness itself, then select **DeepSeek Harness** in Dext. **Dext: Configure Agent** accepts the executable path and discovers model and reasoning choices over ACP; leaving the model unset uses the Harness default. First selection also discovers models. Dext reads the settings-defined `llm-pi-ai.providers` and `agent-default-model` route from `$DSH_HOME/settings.yaml` once at extension startup, refreshes it when Harness is newly selected or configured, then applies the cached result in a temporary ACP overlay. It never copies or changes the user's profile files or `.credentials.yaml`. Dext does not install Harness or manage its credentials.

The published Harness `0.1.2-rc.1` uses ACP SDK `1.4.0`, which Dext pins. Its [official CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) exposes `dsh --profile acp`; the installed package was checked for initialize, new/resume/close, model configuration, prompt and cancellation. New installations show all three backends. `dext.agentCli` can restrict that list.

### Presets and customization

The model menu includes **Agent preset**: Standard, PTC, Minimal and Create come from the installed Harness preset catalog. Choose before the first message; an existing conversation keeps its preset. **ACP default** preserves the original profile composition. Dext mounts the selected preset through an ACP factory adapter without changing the installed Harness files.

For customization, use **Let Agent create a preset** to open a Create conversation with a draft request, or **Copy and open configuration** to copy a preset and edit its `agent.cordis.yml` in VS Code. Copies live in `$DSH_HOME/.agent-presets` (normally `~/.dsh/.agent-presets`), alongside presets created by the Harness web UI. **Refresh presets** picks up file changes and shows configuration errors automatically. Standard and PTC support Dext's restricted permissions. Minimal, Create and custom plugins require **Full access**; their native tools or plugin code can bypass the host sandbox. Dext never raises that permission when selecting a preset.

### Code calls

Code workflows can use `ask(input="Explain this repository", cli="deepseek-harness")`. An optional model object takes `model` (the opaque ACP option value) and `reasoning`; use the composer for human-readable model names. Speed and service-tier controls are unavailable. Typed calls require a final JSON object and are validated by Dext. Invalid output reports failure without automatically repeating work that may already have changed files.

### Sessions and permissions

Dext launches one ACP process per active conversation, reuses its session, and stores the native session ID with a versioned workspace/permission/launch binding. Closing releases the process; persisted sessions remain available for resume. A permission change starts a new session with Dext's recorded context. Forks also start new sessions with the selected history because ACP does not provide native fork. Internal tool state is not copied. A failed resume is reported explicitly.

Ask, preview calls and Plan generation run read-only. Agent and explicit plan execution use the selected write scope. Dext's final configuration overlay pins all Harness permission presets to that scope, including a user's saved default. Escalations in restricted scopes are rejected because ACP does not identify their access boundary; known full-access requests use Dext confirmation. [Windows ACL confinement is partial](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md), including Everyone-writable objects and hard links; it is not strict isolation. Harness also permits its platform temporary areas in workspace-write mode.

### Advanced configuration and compatibility

`dext.agentCliArgs.deepseek-harness` accepts repeated `--patch <path>` launcher pairs in trusted workspaces. Dext owns the ACP profile and appends its permission patch last. Plugins are trusted code: overlays must preserve the shipped sandbox wiring and keep stdout exclusively JSON-RPC. Configuration changes require a new connection. Turns use the total and idle limits described above; ACP setup and model configuration requests retain their separate timeouts. Updates arrive as committed messages and tool events, not token-by-token deltas; context occupancy is not reported as billed token usage.

AIOA/CDP support has been removed. Old AIOA conversations have no compatibility or migration support.

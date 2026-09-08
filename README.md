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

Add files and selections as context, revisit conversations in History, and record a conversation as a starting workflow. Code mode provides API completion, parameter hints, diagnostics, and typed result fields.

Dext supports **Codex CLI, Claude CLI, and DeepSeek Harness**. You can also configure an optional, separate model for inline code completion.

## Installation

Requires **VS Code 1.105 or newer**. For AI tasks, install and authenticate one of the supported Agent CLIs; Dext uses that CLI's credentials.

1. Download `dext-<version>.vsix` from [GitHub Releases](https://github.com/blooddot/dext/releases).
2. Open the VS Code Command Palette and run **Extensions: Install from VSIX...**.
3. Select the downloaded file and reload VS Code if prompted.

To update, install the new VSIX. To build from source, see [Development](docs/development.md).

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

## Feedback and license

Report bugs or request features in [GitHub Issues](https://github.com/blooddot/dext/issues). Include the Dext and VS Code versions, reproduction steps, and relevant logs with credentials removed.

Dext is source-available under the [PolyForm Perimeter License 1.0.1](LICENSE), with separate commercial licensing available by agreement. Ordinary use, including internal business use, is permitted subject to the license. Using Dext to provide a competing product or service to others requires separate authorization, even if that offering is free.

See [commercial licensing](COMMERCIAL-LICENSING.md) for the scope and how to request an agreement. This is a source-available license, not an OSI-approved open-source license. Third-party components retain their own licenses. See [CHANGELOG.md](CHANGELOG.md) for version notes.

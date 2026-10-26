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
| **Code** | Compose API calls into typed workflows | TypeScript |

Plan execution checks reported task progress after every response and continues unfinished, actionable work. Once all tasks are reported complete, Dext requests a separate final verification before displaying `Completed`. Round checkpoints are saved in conversation history without editing the plan document. Clicking **Build** again restores matching tasks from the same plan.

User cancellation displays `Stopped`; explicit external blockers covering every remaining task display `Blocked`. Three consecutive rounds without new completed tasks or new tool activity, or the 64-round execution ceiling, stop with `Incomplete` and preserve the plan. A normal Agent return no longer implies completion. Final verification relies on the Agent inspecting the implementation and checks; task reports alone cannot independently prove correctness.

Add files and selections as context, revisit conversations in History, and record a conversation as a starting workflow. Code mode runs TypeScript in a Node kernel and provides API completion, parameter hints, diagnostics, and typed result fields.

Drag files from the VS Code Explorer, hold **Shift**, and release over the highlighted Dext input to insert file references at the drop position. You can drag multiple selected files together.

Dext supports **Codex CLI, Claude CLI, DeepSeek Harness, and optional Pi CLI**. To associate an already installed Pi, add `pi` to `dext.agentCli`, then run **Dext: Configure Agent**. Dext does not install or repair Pi; see [Pi capabilities and permissions](docs/agents.md#pi).

## Installation

Requires **VS Code 1.106 or newer**. For AI tasks, install and authenticate one of the supported Agent CLIs; Dext uses that CLI's credentials.

Dext defaults to the Secondary Side Bar, on the right in VS Code's default layout. New installations and updates use this location unless you have moved Dext manually; VS Code preserves your chosen position. If Dext still appears elsewhere, right-click its title and move it to the Secondary Side Bar.

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

```ts
import { ask } from "dext";

const answer = await ask({ input: "Explain the structure of this project" });
console.log(answer.text);
```

A Code turn is an ordinary ES module that runs as TypeScript in a long-lived Node child process. There is no Python interpreter and no separate workflow language: Node built-ins (`import fs from "node:fs/promises"`) and any package the workspace resolves work directly, and top-level `await` is available. API arguments and result fields have completion and type checking from VS Code's own TypeScript service.

Strings, arrays and objects are ordinary JavaScript values: build text with template literals (`` `${answer.text} (${checked.exit_code})` ``), and use the standard library (`split`, `join`, `replace`, `toUpperCase`, `Math.max`, `Array.sort`, `text.slice`). See [text and value expressions](docs/workflows.md#text-and-value-expressions).

Save reusable APIs as TypeScript modules under `.dext/api/`. For example, create `.dext/api/team/analyze.ts`:

```ts
import { ask, type AskResult } from "dext";

export async function main(input: string): Promise<AskResult> {
  return await ask({ input });
}
```

Built-in APIs such as `ask`, `agent`, and `terminal` are imported from the `dext` module; custom APIs are imported by their path below `.dext/api`.

In Code mode, import a custom API the same way:

```ts
import { main as analyze } from "dext/api/team/analyze";

const answer = await analyze("Explain task filtering and its tests");
console.log(answer.text);
```

Project APIs require a trusted workspace. You can also right-click a History entry and choose **Record Conversation as Dext Workflow** to generate a starting point for editing. See the [workflow and API reference](docs/workflows.md) for composition, Skills, rules, and UI confirmations.

Dext generates the `dext` type declaration into your project — `.dext/api/dext.d.ts`, plus a small `.dext/tsconfig.json` that maps `dext` at it and `.dext/package.json` that marks the directory as ESM and declares the `@types/node` its API files compile against — and keeps all three current on every API reload. Every path in them is relative, so commit them: `.dext/api/*.ts` and the composer report diagnostics in the **Problems** panel as you type, and a teammate or CI can type-check without Dext installed. See [Generated types](docs/workflows.md#generated-types).

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
| [Workflows and APIs](docs/workflows.md) | TypeScript Code mode, built-in and custom APIs, context, Skills, rules, and History |
| [Agent configuration](docs/agents.md) | CLI setup, model overrides, and DeepSeek Harness presets and permissions |
| [MCP configuration](docs/mcp.md) | Tool manifests, typed results, transports, and credentials |
| [Project knowledge](docs/project-development.md) | Project files, knowledge dimensions, editor tabs, and diagrams |
| [Development and releases](docs/development.md) | Local development, checks, packaging, publishing, and architecture |

## Project knowledge and editor tabs

Project, APIs, Global Resources, and History all open as editor tabs that reuse one page per target and restore the same page after a reload. Project keeps only long-term content — Overview, Knowledge, and Diagrams — and never shows Hook logs, task checklists, or single-run records.

## Feedback and license

Report bugs or request features in [GitHub Issues](https://github.com/blooddot/dext/issues). Include the Dext and VS Code versions, reproduction steps, and relevant logs with credentials removed.

Dext is source-available under the [PolyForm Perimeter License 1.0.1](LICENSE), with separate commercial licensing available by agreement. Ordinary use, including internal business use, is permitted subject to the license. Using Dext to provide a competing product or service to others requires separate authorization, even if that offering is free.

See [commercial licensing](COMMERCIAL-LICENSING.md) for the scope and how to request an agreement. This is a source-available license, not an OSI-approved open-source license. Third-party components retain their own licenses. See [CHANGELOG.md](CHANGELOG.md) for version notes.

# Settings

English | [简体中文](settings.zh-CN.md)

[Back to README](../README.md)

`dext.*` settings decide how a turn is sent, how much history is kept, where Dext writes its files, and how far an Agent may write.

[Composer and history](#composer-and-history) · [Storage and attachments](#storage-and-attachments) · [Permissions and discovery](#permissions-and-discovery) · [Execution limits](#execution-limits)

## Composer and history

- `dext.submitOnEnter` (boolean, default `true`) — sends the message with Enter in Agent, Ask and Plan modes, using Shift+Enter for a newline. Set it to `false` to require Ctrl/Cmd+Enter. Code mode always runs with Ctrl/Cmd+Enter.
- `dext.history.maxTurns` (integer, default `100`, minimum `1`) — turns kept across all conversations. The oldest turns are dropped first, which also removes them from the conversation tab strip.
- `dext.history.maxOutputLength` (integer, default `64000`, minimum `1000`) — characters kept per stored input, process event and serialized output. A longer value keeps its first and last half, and the text removed when a turn is stored goes to that conversation's overflow file, which the turn can open. The same value also caps one live Process row while it streams.

## Storage and attachments

- `dext.storage.location` (`"global"` or `"workspace"`, default `"global"`) — where Dext saves generated plans and pasted image attachments. `global` uses Dext's VS Code global storage; `workspace` writes under the current workspace's `.dext` directory. Existing files stay where they were created.
- `dext.planDirectory` (string, default `.dext/plans`) — workspace-relative directory saved plans go in when `dext.storage.location` is `workspace`.
- `dext.attachments.maxFiles` (integer, default `200`, range 1–1000) — maximum number of pasted image attachments kept in the active storage location. When exceeded, Dext removes the oldest attachments first.
- `dext.attachments.maxBytes` (integer, default `5242880`, range 65536–52428800) — maximum size in bytes for a pasted image, copied terminal output or clipboard context that Dext stores. Workspace `@file` references are not size-limited.

## Permissions and discovery

- `dext.agentPermission` (`"workspace-write"` or `"full-access"`, default `"workspace-write"`) — starting write scope for Agent and Plan. The composer's Permission control overrides it for the current conversation, and Ask is always read-only.
- `dext.hiddenSkills` (array of skill ids, default empty) — Skill ids kept out of the Input skills menu while staying installed, so an API or a stored selection can still load them. The Resources page writes this key at workspace scope when you toggle a Skill's eye button.
- `dext.mcpDirectories` (array of workspace-relative directories, default empty) — additional directories to read MCP manifests from. `.dext/mcp` and Dext's global manifest storage are always searched; [MCP configuration](mcp.md) documents the manifest itself.

## Execution limits

- `dext.terminal.defaultTimeoutMs` (integer, default `120000`, range 1000–600000) — timeout applied to `terminal()` calls that do not pass `timeout_ms`. An invalid value, or one above 600000, falls back to the default, and 600000 is also the hard ceiling for an explicit `timeout_ms`.
- `dext.workflow.maxConcurrency` (integer, default `4`, range 1–16) — how many Dext API calls one Code run may have in flight at once. Calls beyond the limit wait in a queue.

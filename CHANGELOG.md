# Changelog

All notable changes to Dext are documented in this file.

## 0.1.0 - 2026-09-09

Initial release.

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

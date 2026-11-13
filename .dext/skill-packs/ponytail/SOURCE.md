# ponytail skill pack

- Source: https://github.com/DietrichGebert/ponytail.git
- Release: v5.3.3
- Upstream version: 5.3.3
- Versions: all imported; each turn uses its Agent's version, then shared
- Commit: 7801d061243d7b753bad0e0b3c057cd250b11755
- Imported: 2026-11-13T06:39:16.815Z
- Discovery: deterministic
- Skills: ponytail, ponytail-audit, ponytail-debt, ponytail-gain, ponytail-help, ponytail-review
- Commands: ponytail-audit (available), ponytail-debt (available), ponytail-gain (available), ponytail-help (available), ponytail-review (available), ponytail (available)

## Selected sources

- Skill ponytail: .openclaw/skills/ponytail (openclaw)
- Skill ponytail-audit: .openclaw/skills/ponytail-audit (openclaw)
- Skill ponytail-debt: .openclaw/skills/ponytail-debt (openclaw)
- Skill ponytail-gain: .openclaw/skills/ponytail-gain (openclaw)
- Skill ponytail-help: .openclaw/skills/ponytail-help (openclaw)
- Skill ponytail-review: .openclaw/skills/ponytail-review (openclaw)
- Skill ponytail: skills/ponytail (shared)
- Skill ponytail-audit: skills/ponytail-audit (shared)
- Skill ponytail-debt: skills/ponytail-debt (shared)
- Skill ponytail-gain: skills/ponytail-gain (shared)
- Skill ponytail-help: skills/ponytail-help (shared)
- Skill ponytail-review: skills/ponytail-review (shared)
- Command /ponytail-audit: .opencode/command/ponytail-audit.md (shared)
  - Adapted a compatible OpenCode prompt template as a shared Dext command.
- Command /ponytail-debt: .opencode/command/ponytail-debt.md (shared)
  - Adapted a compatible OpenCode prompt template as a shared Dext command.
- Command /ponytail-gain: .opencode/command/ponytail-gain.md (shared)
  - Adapted a compatible OpenCode prompt template as a shared Dext command.
- Command /ponytail-help: .opencode/command/ponytail-help.md (shared)
  - Adapted a compatible OpenCode prompt template as a shared Dext command.
- Command /ponytail-review: .opencode/command/ponytail-review.md (shared)
  - Adapted a compatible OpenCode prompt template as a shared Dext command.
- Command /ponytail: .opencode/command/ponytail.md (shared)
  - Adapted a compatible OpenCode prompt template as a shared Dext command.

## Hooks

Copied under `upstream/` and recorded verbatim; Dext never executes them.

- codex SessionStart (matcher: startup|resume|clear|compact, 15s): node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/ponytail-activate.js'))"
- codex SubagentStart (15s): node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/ponytail-subagent.js'))"
- codex UserPromptSubmit (15s): node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/ponytail-mode-tracker.js'))"
- claude SessionStart (matcher: startup|resume|clear|compact, 15s): node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/ponytail-activate.js'))"
- claude SubagentStart (15s): node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/ponytail-subagent.js'))"
- claude UserPromptSubmit (15s): node -e "require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT.split(String.fromCharCode(92)).join('/'), 'hooks/ponytail-mode-tracker.js'))"

## Import notes

- .codex-plugin/plugin.json: native plugin configuration is not installed; 1 hook configuration file(s) are copied under upstream/ and never executed.
- .claude-plugin/plugin.json: native plugin configuration is not installed; 2 hook configuration file(s) are copied under upstream/ and never executed.

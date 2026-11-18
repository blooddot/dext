# open-code-review skill pack

- Source: https://github.com/alibaba/open-code-review
- Release: v1.13.12
- Upstream version: 0.0.0
- Versions: all imported; each turn uses its Agent's version, then shared
- Commit: f921d6a0de3b71befce15d8edf589cd3609968fa
- Imported: 2026-11-18T08:07:30.454Z
- Discovery: AI-assisted selection
- Summary: Import the two independent canonical review skills covering native OCR review and host-agent delegated review.
- Skills: open-code-review, open-code-review-delegate
- Commands: commit (unavailable), tag (unavailable)

## Selected sources

- Skill open-code-review: plugins/open-code-review/skills/open-code-review (codex)
- Skill open-code-review-delegate: plugins/open-code-review/skills/open-code-review-delegate (codex)
- Skill open-code-review: skills/open-code-review (shared)
- Skill open-code-review-delegate: skills/open-code-review-delegate (shared)

## Import notes

- plugins/open-code-review/.codex-plugin/plugin.json: native plugin configuration and hooks are not installed.
- plugins/open-code-review/claude-code/.claude-plugin/plugin.json: native plugin configuration and hooks are not installed.

## Unavailable commands

- commit (.claude/commands/commit.md): Command does not map to a selected skill.
- tag (.claude/commands/tag.md): Command does not map to a selected skill.

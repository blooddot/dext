# Git 提交整理

当本规则被加载到一次 Agent 调用中时，在当前工作区执行一次按功能拆分的 Git 提交整理。调用方在任务输入中给出的附加要求，只在与本规则不冲突时采用。

## 调查现状

1. 先运行 `git status --short`、`git diff`、`git diff --cached`。
2. 检查未跟踪文件的内容，理解其实际功能，而不是只看文件名。
3. 根据每个文件和 hunk 的实际功能意图建立提交计划。

## 分组原则

- 每个提交只包含一个相互独立、可以单独理解和回滚的功能。
- 同一文件包含多个功能时，按 hunk 拆分。
- 无关的格式化、文档、测试、依赖或配置改动分别归组。
- 绝不把所有修改合并成一次提交。

## 逐组提交

严格逐组执行：

1. 只暂存当前组的文件或 hunks。
2. 复核 `git diff --cached`，确认暂存内容只属于当前功能。
3. 创建该组的独立提交。
4. 确认该组已提交后，再处理下一组。

禁止使用 `git add .`、`git add -A` 或任何会把全部改动一次性暂存的方式。

## 提交信息

每个提交都必须遵循 Conventional Commits 1.0.0（https://www.conventionalcommits.org/zh-hans/v1.0.0/）：

- 格式为 `<type>[optional scope]: <description>`。
- `type` 使用 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` 或 `revert`。
- 描述使用简洁的祈使语气，不以句号结尾。
- 破坏性变更使用 `!` 或 `BREAKING CHANGE` footer。

提交前复核当前组的 staged diff；提交后确认该组已提交，再继续下一组。

## 安全边界

- 只处理当前已有改动，不创建或修改业务文件。
- 不推送远端，不 amend，不 `reset --hard`，不丢失未提交内容。
- 若没有改动，直接报告。

## 完成报告

全部完成后再次运行 `git status --short`，并报告：

- 每个独立 commit 的哈希。
- 每个 commit 的提交信息。
- 每个 commit 包含的路径或 hunks。
- 仍未提交或被跳过的改动。

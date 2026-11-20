# 按 OpenSpec change 提交

将调用方指定的一个 OpenSpec change 对应的现有改动提交为一个 Conventional Commit。

## 确定提交范围

1. 若参数为 `YYYY-MM-DD-<change>`，优先在 `openspec/changes/archive/` 中按完整目录名精确查找。找到后直接选中该归档，并用日期前缀后的原 change 名核对原活跃目录。
2. 若未选中归档，按原参数查找 `openspec/changes/<change>/`。若没有活跃目录，在 `openspec/changes/archive/` 中按去除日期前缀后的完整 change 名称匹配。找不到或匹配到多个归档目录时，报告具体情况并结束。
3. 阅读该 change 的 `proposal.md`、`tasks.md`、规格增量以及已有的 `design.md`。先检查 `git status --short`、`git diff` 和 `git diff --cached`，再阅读相关的未跟踪文件。用实际改动核对规格、实现、测试和文档的归属。对于已归档的 change，核对归档目录、原活跃目录的移除以及合并到 `openspec/specs/` 的对应增量。
4. 只选择能归属到该 change 的改动。同一文件包含其他工作的改动时，按 hunk 选取。若无法判断相关改动的归属或无法拆开混合改动，列出具体路径、hunk 和需要用户确认的问题，本次结束。无相关改动时直接报告。

## 创建提交

1. 暂存前记录 HEAD 和当前暂存区。按文件或 hunk 构造候选提交，确保无关改动保持原有的暂存或未暂存状态。已有无关暂存项时，在临时索引中从 HEAD 构造候选提交，并基于候选提交树预先验证能否重放原有的无关暂存差异。同一路径上的无关暂存 hunk 也要保留。无法安全重放时，在修改 HEAD 或真实索引前报告并结束。
2. 在实际用于提交的索引上检查 `git diff --cached`，核对当前 HEAD 和涉及的 diff 仍与筛选时一致。只创建一个 `<type>[optional scope]: <description>` 格式的 Conventional Commit，并在提交信息末尾追加一行 trailer `OpenSpec-Change: <完整归档目录名，无归档时为原 change 名>`。标题只描述代码改动本身，不包含 change 名称或日期前缀。禁止全量暂存、修改工作区文件、自动归档、推送、amend 和 `reset --hard`。
3. 使用临时索引提交成功后，将真实索引同步为新的提交树加上已验证的无关暂存差异，保留工作区文件。提交失败时撤销本次造成的暂存变动，保留调用前用户的改动。
4. 核对新 commit 的内容及 `git status --short`，确认无关暂存项和未暂存改动保留。报告提交哈希、提交信息（含 `OpenSpec-Change` trailer）、包含的路径或 hunks，以及被跳过的改动。

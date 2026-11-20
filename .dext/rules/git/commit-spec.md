# 按 OpenSpec change 提交

将调用方指定的一个 OpenSpec change 对应的现有改动提交为一个 Conventional Commit。

## 确定提交范围

1. 调用方输入里的 `Scope:` 段由主机读取磁盘得出：change 目录、`owned prefixes`、已暂存与 dirty 路径、diffstat、快速通道是否可用。**这些事实不得再运行 `git status`、`git diff`、`git ls-files` 复核**，只按它判断归属。
2. 没有 `Scope:` 时自行解析目录：先 `openspec/changes/<change>/`，再 `openspec/changes/archive/`，`YYYY-MM-DD-` 前缀按原 change 名匹配，匹配到多个时报告并结束；然后读该 change 的 `proposal.md`、`tasks.md`、规格增量和已有的 `design.md`，并查 `git status --short`、`git diff`、`git diff --cached`。
3. `owned prefixes` 下的路径无需判断即属于该 change（change 目录本身，以及合并后的 `openspec/specs/<capability>/`）。只有 `outside the change` 列出的路径需要你判断是否属于本次 change，必要时读它的 diff。
4. 无法判断归属或无法拆开混合改动时，列出具体路径、hunk 和需要用户确认的问题，本次结束。无相关改动时直接报告。

## 快速通道

`Scope:` 标为 `快速通道: 可用` 时，整份 diff 就是这一个 change，不要分组，也不要构造临时索引：

1. `git add -- "<路径>"` 暂存 `Scope:` 的整个 dirty 列表，不逐 hunk 挑选。
2. 按「提交信息」一节写提交信息，用 `git commit -F <文件>` 提交。
3. `git show --stat HEAD` 与 `git status --short` 核对后报告。

## 创建提交

以下步骤只用于快速通道不可用时的按 hunk 拆分。

1. 暂存前记录 HEAD 和当前暂存区。按文件或 hunk 构造候选提交，确保无关改动保持原有的暂存或未暂存状态。已有无关暂存项时，在临时索引中从 HEAD 构造候选提交，并基于候选提交树预先验证能否重放原有的无关暂存差异。同一路径上的无关暂存 hunk 也要保留。无法安全重放时，在修改 HEAD 或真实索引前报告并结束。
2. 在实际用于提交的索引上检查 `git diff --cached`，核对当前 HEAD 和涉及的 diff 仍与筛选时一致。禁止全量暂存、修改工作区文件、自动归档、推送、amend 和 `reset --hard`。
3. 使用临时索引提交成功后，将真实索引同步为新的提交树加上已验证的无关暂存差异，保留工作区文件。提交失败时撤销本次造成的暂存变动，保留调用前用户的改动。
4. 核对新 commit 的内容及 `git status --short`，确认无关暂存项和未暂存改动保留。报告提交哈希、提交信息（含 `OpenSpec-Change` trailer）、包含的路径或 hunks，以及被跳过的改动。

## 提交信息

一次调用只创建一个 `<type>[optional scope]: <description>` 格式的 Conventional Commit，并在提交信息末尾追加一行 trailer `OpenSpec-Change: <完整归档目录名，无归档时为原 change 名>`。标题只描述代码改动本身，不包含 change 名称或日期前缀。

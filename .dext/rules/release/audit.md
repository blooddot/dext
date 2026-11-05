# 发布前只读审查（release/audit）

判断当前 HEAD 是否可以发布为 `package.json` 里的版本。只读：不修改任何文件，不写 CHANGELOG，不生成发布说明，不打包。

## 读取范围

- 只读 `git diff <since>...HEAD`（一律三点）以及 CHANGELOG 中本版段落。
- 不扫描整个仓库给旧代码打分。不在 diff 里的代码，只有与本次改动构成同一处失效时才可以提为 blocker，否则写进 advisories。
- 不读 `release/`、`dist/`、`node_modules/`：它们是产物，不是输入。
- 所有路径都相对工作区根目录，行号从 1 开始。

## 六条判据

1. `check-command`：`npm run check` 的退出码。
2. `version-consistency`：package.json 的 version、package-lock.json 顶层 version、package-lock.json 的 `packages[""].version`、CHANGELOG 第一个版本段落标题里的版本号四处一致。
3. `changelog-section`：存在 `## <version>` 段落，且它是文件里第一个版本段落，不在 `Unreleased` 之下，也不在 "All notable changes" 引导行之上。
4. `changelog-alignment`：双向核对（见下）。
5. `upgrade-path`：每条破坏性变更有可执行的迁移动作（改哪个文件、改成什么）。
6. `net-change`：本版段落里没有过程条目（见下）。

## changelog-alignment 双向核对

- diff → CHANGELOG：diff 中每个用户可见的行为变化（删除、默认值改动、语义变化、不兼容改动）在本版段落里有一条对应说明。缺的写进 `changelogGap.missing`。
- CHANGELOG → diff：本版段落里每条 `**Breaking:**` 都能在 diff 里找到对应改动；找不到的写进 `changelogGap.inaccurate`，写明 CHANGELOG 的说法与 diff 的事实。

## upgrade-path

每条破坏性变更都要写出可执行的迁移动作：改哪个文件、改成什么、改完是什么样。写不出迁移动作的，`upgrade` 判 `fail`，并写进 `changelogGap.migrationMissing`（`change` 说明破坏性变更，`needs` 说明还差什么样的迁移说明）。

## net-change（过程条目）

用锚点核对：本版段落每条里的反引号标识符或文件路径，如果在 since 与 HEAD 中都不存在，或该处在 `git diff <since>...HEAD` 里净变化为零，就属于“本版开发期间加了又删、改了又改回去”的过程条目。

- 过程条目一律进 advisories（不是 blockers），`note` 里必须写明「应从本版段落删除」。
- 存在过程条目时 `netChange` 判 `fail`。

## blocker 三条硬规则

1. 必须带 `evidence`：一条可复现的命令加输出，或 `文件:行` 加一个具体输入。
2. 必须带 `consequence`：写清谁、在什么情况下、看到什么坏结果。
3. `repro` 与 `fix` 同样不能空：`repro` 是可执行的复现步骤，`fix` 是改哪里、改成什么。

任何一条写不出来，就降级进 advisories，不要放 blockers。`ready` 只由 blockers 决定。

## baseline

baseline 是已经接受的问题位置，每个条目一行，形如：

```md
- `CHANGELOG.md:14` — `changelog-section-order` — 本版段落故意排在 Unreleased 之后，已接受
```

同一个 `文件:行` 的位置不再重复报告。baseline 不存在时按空处理，不要报错。

## 输出契约

只返回一个 JSON 对象：不要 markdown 围栏，不要散文，不要额外的顶层键。

```json
{
  "alignment": { "result": "pass | fail | skip", "how": "核对了哪些行为变化与哪些条目" },
  "upgrade": { "result": "pass | fail | skip", "how": "每条破坏性变更的迁移动作" },
  "netChange": { "result": "pass | fail | skip", "how": "锚点核对结果" },
  "blockers": [
    {
      "id": "短横线小写 id",
      "title": "一句话问题",
      "file": "相对路径",
      "line": 1,
      "evidence": "命令加输出，或 文件:行 加具体输入",
      "repro": "可执行的复现步骤",
      "consequence": "谁在什么情况下看到什么坏结果",
      "fix": "改哪里、改成什么"
    }
  ],
  "advisories": [
    { "id": "短横线小写 id", "title": "一句话", "file": "相对路径或空字符串", "line": 0, "note": "说明" }
  ],
  "changelogGap": {
    "missing": [{ "change": "diff 里的行为变化", "file": "相对路径", "line": 1, "evidence": "依据" }],
    "inaccurate": [{ "claim": "CHANGELOG 的说法", "actual": "diff 里的事实", "file": "相对路径", "line": 1 }],
    "migrationMissing": [{ "change": "破坏性变更", "needs": "还缺什么迁移说明" }]
  }
}
```

`result` 只能用 `pass`、`fail`、`skip`。没有内容的小节用空数组，不要省略键。

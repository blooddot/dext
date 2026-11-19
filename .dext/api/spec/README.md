# spec — OpenSpec 工作流

把 `openspec` 技能包（`.dext/skill-packs/openspec`，由同目录的 `install.mjs` 生成）里的 6 个 skill 包成有类型提示的函数，省掉「记住 skill id」这一步。

```ts
import { propose, apply, archive } from "dext/api/spec";
```

每次调用都是一次独立的 agent 运行，返回 `{ kind: "skill", text }`——**不接续当前对话**。想和 agent 来回讨论，就在 Input 里直接选 skill。

要写盘的那 5 个函数会在 `text` 末尾追加一段 git 观测结果：

```
Files changed:
- openspec/changes/add-video-export/proposal.md
- openspec/changes/add-video-export/tasks.md
```

一行都没有时写 `Files changed: none — no file entered or left git's dirty set during this run.`，
这就是「产物到底落盘没有」的答案。依据是 `git status --porcelain -uall` 的前后差集，不是
`AgentResult.files`：后者是模型自己在 JSON 信封里填的字段，`patch: false` 时宿主没有落盘观测，
它写什么都是自称。运行前已经脏的路径会单独提一句数量，不列成「本次改动」——git 归因不了。
工作区不是 git 仓库时这一段不出现，调用本身不受影响。

## 函数

| 函数 | 做什么 | 写文件 |
|---|---|---|
| `propose(input)` | 生成 proposal / spec delta / design / tasks | 只写 `openspec/changes/<name>/` |
| `apply(change)` | 按 `tasks.md` 逐条实现，边做边勾 | 改代码 + `tasks.md` |
| `archive(change)` | 合并 delta 进 `specs/`，整个 change 挪进 `archive/` | 改 `openspec/specs/` |
| `explore(input)` | 读代码和 specs 回答问题 | 不写 |
| `update(change, input?)` | 修订还在规划中的 change | 改 change 目录 |
| `sync(change?)` | 让 `specs/` 追上代码现状 | 改 `openspec/specs/` |

`change` 是 change 名（`openspec/changes/<name>/` 里那个 `<name>`，CLI 的 `--change "<name>"`），
单独一个参数，不混在 `input` 里；`input` 只放本次的额外要求。`propose` / `explore` 没有 change 名可给，
仍然只有一个 `input`。
`apply` / `archive` / `sync` 没有第二个参数：这三个 skill 的 input 契约里就只有 change 名，其余都自己问。

## 权限

`skill()` 默认只读，只有显式传 `apply: true` 才会拿到写入与命令执行权限：`src/features/workflow/host/runtime.ts`
里 `agent` 默认开启 `allowWorkspaceWrite`，`skill` 必须 `apply: true`，否则 `permission: "read-only"`。
只读的 `skill()` 没有 shell，`openspec new change` 跑不了，proposal / specs / design / tasks 只能写回回复
正文——这就是 `propose` 曾经「执行完什么文件都没有」的原因。

因此上表里要写盘的 5 个函数继续走 `agent({ skills: [id], apply: true, patch: false })`（`skill({ apply: true })` 也能写，
这里不改现有写法）：加载同一个
`SKILL.md`、用当前 Agent 的写入权限执行，工作区由 CLI 自己改，不再回传 patch 让宿主二次落盘。
`explore` 保持 `skill()`，因为它本来就只读。

写权限要求可信本地工作区；不受信任时 `agent(apply: true)` 会直接拒绝，而不是悄悄降级成只读。
用于观测的 `terminal()` 同样要求可信工作区。

## 一轮

```ts
propose("给视频标注加导出按钮");
// → openspec/changes/add-video-export/
//     proposal.md  ← 先读这个：Capabilities 和 Impact 两节
//     specs/video-annotation/spec.md
//     design.md
//     tasks.md
// 这一步不改代码。

apply("add-video-export");
// 真改代码，逐条勾 tasks.md。

archive("add-video-export");
// delta 合并进 openspec/specs/，change 挪进 changes/archive/。
// 纯工具/文档改动加 --skip-specs（CLI 参数，skill 里会问）。
```

`openspec/specs/` 是唯一会长期留下的东西：它记「系统现在承诺什么行为」。`proposal.md` / `design.md` / `tasks.md` 都是这次改动的临时脚手架。

## 什么时候别用

改动没变「对外承诺的行为」——typo、一行 bug、纯重构、内部改名。直接改代码，别 propose。

判断就一句：**这次改动会不会让某个 `spec.md` 里的 Requirement 变**。

## 依赖

函数只是壳，真活由全局 CLI 干：

```bash
npm i -g @fission-ai/openspec      # 装一次
openspec list --json               # 应返回 root，不是 null
```

`root: null` 说明当前目录往上没有 `openspec/`，所有命令都会失败。

刷新 skill 文件（CLI 升级后），重跑包自带脚本：

```bash
node .dext/skill-packs/openspec/install.mjs
```

Resources → Skill → `openspec` 行右侧的 ▶ 按钮跑的是同一条命令（会先弹确认框显示具体命令行）。

它把 `openspec init --tools codex` 的产物写进 `.dext/skills/openspec-*`，并重写同目录的 `pack.json`。刷新后需要 Reload Window。

这 6 个 skill 默认在 `dext.hiddenSkills` 里：Input 菜单看不到它们，但 API 和已保存的选择照样能按 id
加载，`spec.*` 就是靠这一点工作的。

`openspec/config.yaml` 里的 `context:` 值得填几行——它是 proposal 理解这个仓库的唯一提示，现在空着，全靠 agent 现场读代码。

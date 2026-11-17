# spec — OpenSpec 工作流

把 `openspec` 技能包（`.dext/skill-packs/openspec`，由同目录的 `install.mjs` 生成）里的 6 个 skill 包成有类型提示的函数，省掉「记住 skill id」这一步。

```ts
import { propose, apply, archive } from "dext/api/spec";
```

每次调用都是一次独立的 agent 运行，返回 `{ kind: "skill", text }`——**不接续当前对话**。想和 agent 来回讨论，就在 Input 里直接选 skill。

## 函数

| 函数 | 做什么 | 写文件 |
|---|---|---|
| `propose(需求)` | 生成 proposal / spec delta / design / tasks | 只写 `openspec/changes/<name>/` |
| `apply(change名)` | 按 `tasks.md` 逐条实现，边做边勾 | 改代码 + `tasks.md` |
| `archive(change名)` | 合并 delta 进 `specs/`，整个 change 挪进 `archive/` | 改 `openspec/specs/` |
| `explore(问题)` | 读代码和 specs 回答问题 | 不写 |
| `update(要改什么)` | 修订还在规划中的 change | 改 change 目录 |
| `sync(范围)` | 让 `specs/` 追上代码现状 | 改 `openspec/specs/` |

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

`openspec/config.yaml` 里的 `context:` 值得填几行——它是 proposal 理解这个仓库的唯一提示，现在空着，全靠 agent 现场读代码。

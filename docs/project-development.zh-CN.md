# 项目知识与对话 Review

[English](project-development.md) | 简体中文

[返回 README](../README.zh-CN.md)

Dext 把两类理解严格分开：**项目知识**长期存在、属于仓库；**对话 Review**只描述某一次运行，永不写回项目。

[项目文件](#项目文件) · [知识维度](#知识维度) · [对话 Review](#对话-review) ·
[Review 预设](#review-预设) · [编辑器标签](#编辑器标签) · [架构扫描](#架构扫描) · [校验](#校验)

## 项目文件

项目数据位于工作区的 `.dext/` 下，由三类文件承担：

| 路径 | 内容 |
| --- | --- |
| `.dext/project.json` | schema 版本、乐观锁 `version`、默认 Review 预设、知识开关 |
| `.dext/objects/<id>.json` | 每个文件一个已确认的长期对象 |
| `.dext/architecture.json` | 人工声明的模块关系、规则与设计决策 |

`ProjectStore` 通过一个极小的文件宿主机读写这些文件，因此同一套逻辑可运行在扩展、worker 或内存测试替身中。每次写入都携带期望的 `version`；并发修改返回 `{ status: "conflict" }` 而不会覆盖。`project.json` 缺失或损坏时回退默认值，绝不阻塞开发。

`ProjectObjectReference` 保存稳定的 `objectId`。重命名对象会保留 id 并把旧名记入别名，引用、链接与测试因此不会因改名而失效。

## 知识维度

项目对象携带四个彼此独立的维度，绝不合并成单一状态。

- **来源**（`source`）：`code`、`ai`、`user`。
- **确认**（`confirmation`）：`draft`、`accepted`、`rejected`——用户决定。
- **有效性**（`validity`）：`current`、`needs_verification`、`stale`、`conflicted`——与代码再核对的结果。
- **归属**（`ownership`）：`owned`、`shared`、`candidate`、`unassigned`。

接受 AI 建议会设置 `confirmation: "accepted"`，但 `validity` 仍为 `"needs_verification"`：接受建议不等于已对当前代码核实。`validateProjectObjects` 会报告重复 id、重复名称/别名以及悬空的 `relatedIds`。

旧字段 `status` 仍可解析。`normalizeProjectObject` 负责迁移：`accepted`、`stale`、`conflicted` 都映射为 `confirmation: "accepted"`，并补齐其余维度。新代码只写四个维度。

## 对话 Review

`TurnReview` 以 `sessionId + turnId + runId` 为键，反馈绝不会落到另一次运行、更早的尝试或别的 Plan Build 上。Review 还会记录产生时的 `projectVersion`、`planVersion`、`buildRunId`；`reviewRepresentsVersion` 会拒绝基于旧项目版本得出的结论。

`TurnReviewStore` 在内存中保存 Review，按最旧优先淘汰并有上限；`TurnReviewController` 提供宿主所需动作：`find`、`submitFeedback`（返回 `not_found`、`stale`、`accepted`、`rejected`）、`diffTargets`、`acceptanceCard`、`adoptKnowledgeSuggestion`。接受代码改动与采纳知识建议是两个独立决定，后者会拒绝过期的 `baseVersion`。

### 单轮 Review 视图

`renderTurnReview` 生成可折叠区域。纯 Ask 轮次，或没有开发改动、也没有待验收内容的轮次，不产生验收卡片。只有提供方明确报告过 Hook 结果时才展示；未知或失败的 Hook 绝不会渲染成通过。

### Plan Review

`buildPlanReview` 汇总同一个 Build 的每一轮。`associatePlanChanges` 只依据显式记录的任务关联来分组：被多个任务同时拥有的改动进入「共享改动」，没有任何关联的改动保持「未归属」。Dext 绝不根据 AI 的任务勾选推断文件归属。`finalizePlanReview` 记录 Build 级决定；中间任务 Review 从不阻塞续写，只有最终 Review 等待用户。

## Review 预设

两个预设改变 Review 的关注点，与 Ask/Agent/Plan/Code 相互独立：

- **engineering** 侧重设计决策、模块边界与改动理由。
- **experience** 侧重行为变化、反馈与手工验证。

`resolveReviewPreset` 依据项目默认值与可选的单次覆盖决定预设。Ask 模式下结果为只读，并记录捕获时间。

## 编辑器标签

项目、API、全局资源与历史都以编辑器标签打开，并共用同一层：

- `editorTabTypes` 定义标签种类、视图类型、标题、页面与稳定键格式。
- `editorTabState` 校验持久化状态；未知页面回退到该类型的默认页。
- `editorTabManager` 对每个键最多创建一个面板，支持 reveal/close，并使用注入的宿主机，便于脱离 VS Code 测试。
- `editorTabSerializer` 提供与 `WebviewPanelSerializer` 兼容的恢复路径，并带占用守卫，因此序列化恢复与主动恢复不会重复打开同一标签。

项目标签只暴露 **概览**、**知识**、**架构**三页；不设 Hook、Review 或任务执行页，也不会向其加载任何运行元数据。

## 架构扫描

`runArchitectureScan` / `startArchitectureScan` 按文件数、文件大小与时长限制扫描，并报告跳过文件的覆盖率。取消是协作式的：返回带 `cancelled: true` 的部分结果，而不是抛错。

- **TypeScript/JavaScript** 使用解析器事实。
- **Python** 解析 `from .mod import x` 相对导入、`__init__` 与命名空间包；歧义、未解析或动态导入记入 unsupported，绝不猜测。
- **Rust** 在匹配前先剥离注释、文档与字符串字面量，因此注释或字符串里的 `use` 永远不会被当作依赖。`crate`/`self`/`super` 路径、分组与再导出的 `use`、以及 `mod` 声明都会解析到已扫描模块。`#[cfg]`、宏与 include 记为不确定。`parseCargoManifest` 无需运行 Cargo 即可读取 `Cargo.toml` 的描述与依赖名；`readRustProjectMetadata` 可选地沿用调用方既有权限调用 `cargo metadata` 补充，进程不可用时降级为清单并明确说明覆盖范围。

Tauri IPC 契约等人工关系标记为 `declared`，在架构视图中与 `detected` 关系分开呈现；视图在本地渲染 SVG，不依赖浏览器地址。

## 校验

```bash
npm run check      # tsc --noEmit、eslint 与生产构建
npm run test:host  # VS Code 激活冒烟测试
```

项目层单元测试可运行：`npx vitest run test/project*.test.ts test/editorTab*.test.ts test/turnReview*.test.ts`。

# Proposal

## Why

回合内容已部分共用 HTML 与 DOM 渲染，Todo、验收和 trace 的行与折叠结构仍由多个入口分别构建。脚本需要能提交只读输出，使它与 Dext 自有 UI 一样经过明确的组件契约，并能从历史恢复。

## What Changes

- 把 Plan Todo 和 agent trace 迁移到同一组八个 Trace 部件。由调用方组合标题、计数、状态、任务验证、验收和过程详情，保留现有标签层级、类名、状态枚举和文案。
- A 群通过现有 `TurnRenderAdapter` 共享 HTML 和 DOM 构建。B 群复用原子并保留浏览器侧的原生控件和宿主绑定。依次迁移回合、Todo、历史、表单、标签和菜单。
- 在现有 `ui` 命名空间新增显示型脚本入口 `ui.render({ nodes })`。`nodes` 是只读显示树的顶层 JSON 节点数组。每次调用经校验后在既有 Output 中生成一项，并支持历史重放。
- 为 Tier 2 保留名称与 schema 目录条目，待消费者出现时再开放。菜单定位计划采用 CSS Anchor Positioning，先证明其在现有容器内与夹取逻辑等价，再移除定位脚本。保留现有类名，样式变更限定在有依据的定位规则。
- 保持现有依赖、VS Code 主题变量、`dext-todo`、Webview 消息信封及 `planProgress` 持久化契约。

## Capabilities

### New Capabilities

- `conversation-view-components`：回合与历史的双介质部件、共享 Trace 组合及 Webview 控件的行为契约。
- `script-view-output`：脚本只读组件树的校验、输出追加和历史重放。

### Modified Capabilities

## Impact

- `src/features/conversations/presentation/`、`browser/`、`src/webview/main.ts` 与 `src/app/sidebarProvider.ts` 的组件构建和相关测试。
- `src/shared/contracts/`、`src/features/workflow/`、`src/runner/`、声明生成及 API Reference 增加显示入口和输出类型。
- `plan-acceptance` 的勾选、焦点、独立计数和完成规则继续适用。`plan-document-persistence`、`agent-result-boundary` 与 Pi 提交仍使用各自的契约。

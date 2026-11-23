# Proposal

## Why

`unify-ui-primitives` 已使 Plan Todo、过程、回合与脚本输出复用一部分组件。侧栏静态外壳、历史、资源与媒体面板仍分别维护常见结构、样式或控件行为，脚本也缺少能容纳普通内容的布局与分组部件。

## What Changes

- 在仓库内建立 Dext 通用组件目录，为组件定义部件树、默认值、状态、可访问性和宿主绑定边界。沿用 TypeScript、原生 HTML、VS Code 主题变量和 DOM／HTML 适配器。
- 从当前注册入口建立界面迁移索引。会话、Composer、Process、Output、交互、History、资源、API Reference、预览和媒体界面逐批接入，原生 VS Code 界面、Monaco、画布和 Mermaid 等经宿主适配使用。保留现有视觉和交互基线。Composer 聊天模式正式取消 `@` 文件候选并移除对应提示，文件引用继续可用。
- 先通过正常入口验证 Plan Todo／Output、内置 API Reference 详情与用户扩展报告三条路径。验证共用实现与各自的业务职责后再扩大迁移。
- 保持 `ui.render({ nodes })` 只读、逐项追加与可回放，补充 `Stack`、`Inline`、`Section`、`Empty` 以及面向一般反馈的 Badge 色调。将首批组件的 TypeScript 类型、嵌套规则和组合示例交付到 API Reference。
- 用户脚本可以在报告后调用现有 `ui.form` 或 `ui.confirm` 并读取结果。内容内受控动作和独立脚本面板留待有消费者时另行设计。

## Capabilities

### New Capabilities

- `dext-ui-foundation` 约束全局组件、Dext 自有页面的可追踪组合、双介质与专用宿主接入，以及跨界面的交互基线。

### Modified Capabilities

- `script-view-output` 扩展递归只读树、公开类型和 API Reference，并约定从报告到现有表单的交互闭环。

## Impact

- 影响 `src/shared/lib/ui/`、`src/shared/contracts/uiView.ts`、桌面 Webview 壳、各功能页面、原生宿主适配和组件样式资产。会话内原有 `conversation-view-components` 与 `plan-acceptance` 规格继续作为迁移回归基线。
- 影响工作流契约及校验、脚本类型声明、API Reference 生成、可运行示例，以及实时、历史和编辑器标签的正常入口测试。保留消息协议、持久化格式、现有依赖和交互方法签名。
